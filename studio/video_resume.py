"""Durable checkpoint storage for resumable browser-rendered video exports."""

import hashlib
import json
import os
import re
import signal
import shutil
import subprocess
import threading
import time
import uuid
import fcntl
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = 1
SEGMENT_NAME = re.compile(r'segment-(\d{6})\.mkv')
_SYSTEM_RUN = subprocess.run


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_directory(path):
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        # Some mounted filesystems do not expose directory fsync.
        pass


def _durable_fsync(stream):
    try:
        os.fsync(stream.fileno())
        if hasattr(fcntl, 'F_FULLFSYNC'):
            fcntl.fcntl(stream.fileno(), fcntl.F_FULLFSYNC)
    except OSError:
        pass


def atomic_write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temporary.open('x') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            _durable_fsync(stream)
        temporary.replace(path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


class VideoJobStore:
    def __init__(self, root, ffmpeg, idle_timeout=300):
        self.root = Path(root).resolve()
        self.ffmpeg = str(ffmpeg)
        self.idle_timeout = float(idle_timeout)
        self.videos = self.root / 'videos'
        self.index_path = self.videos / '.video-job-index.json'
        self.lock = threading.RLock()
        self.job_locks = {}
        self.active = {}
        self.leases = {}
        self.owners = {}
        self.server_owner = None
        self.popen = subprocess.Popen
        self.run = subprocess.run
        self.clock = time.monotonic
        self.process_command = self._process_command
        self.processes_for_path = self._processes_for_path
        self.kill_pid = self._kill_pid
        self.last_recovery = self._empty_recovery_report()
        self.recovery_running = False

    @staticmethod
    def _process_command(pid):
        completed = _SYSTEM_RUN(
            ['ps', '-p', str(pid), '-o', 'command='],
            capture_output=True, text=True, timeout=5,
        )
        return completed.stdout.strip() if completed.returncode == 0 else ''

    @staticmethod
    def _kill_pid(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            return

    def _is_encoder_command(self, command, path, executable=None):
        command = command.strip()
        expected = str(executable or self.ffmpeg)
        return command.startswith(expected + ' ') and str(path) in command

    def _processes_for_path(self, path):
        completed = _SYSTEM_RUN(
            ['ps', '-axo', 'pid=,command='],
            capture_output=True, text=True, timeout=5,
        )
        if completed.returncode != 0:
            raise OSError('Could not inspect running encoder processes')
        output = completed.stdout
        expected_path = str(path)
        matches = []
        for line in output.splitlines():
            fields = line.strip().split(None, 1)
            if len(fields) != 2:
                continue
            pid, command = fields
            if pid.isdigit() and self._is_encoder_command(command, expected_path):
                matches.append(int(pid))
        return matches

    @staticmethod
    def _empty_recovery_report():
        return {
            'recovered': 0,
            'alreadyExited': 0,
            'refused': 0,
            'skippedActive': 0,
            'failed': 0,
            'indexFailed': False,
        }

    def claim_server(self):
        self.videos.mkdir(parents=True, exist_ok=True)
        stream = (self.videos / '.server.lock').open('a+')
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            stream.close()
            raise ValueError('Another video server is already using this project') from error
        self.server_owner = stream

    def release_server(self):
        stream, self.server_owner = self.server_owner, None
        if stream:
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            finally:
                stream.close()

    @staticmethod
    def _claim_recovery_lock(job_dir):
        stream = (job_dir / '.owner.lock').open('a+')
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return stream
        except BlockingIOError:
            stream.close()
            return None

    def recover_stale_encoders(self):
        self.recovery_running = True
        try:
            return self._recover_stale_encoders()
        finally:
            self.recovery_running = False

    def _recover_stale_encoders(self):
        report = self._empty_recovery_report()
        try:
            with self.lock:
                index = self._read_index()
                entries = list(index['jobs'].items())
        except Exception:
            report['failed'] += 1
            report['indexFailed'] = True
            self.last_recovery = report
            return dict(report)

        for job_id, entry in entries:
            manifest_hint = (
                Path(entry['manifest']) if isinstance(entry, dict)
                and isinstance(entry.get('manifest'), str) else None
            )
            recovery_lock = None
            try:
                if manifest_hint is None:
                    raise ValueError('Video job index entry is invalid')
                recovery_lock = self._claim_recovery_lock(manifest_hint.parent)
                if recovery_lock is None:
                    report['skippedActive'] += 1
                    continue
                with self._job_lock(job_id):
                    manifest, job = self._load(job_id)
                    encoder = job.get('activeEncoder')
                    if not isinstance(encoder, dict):
                        expected_pending = manifest.parent / f".segment-{len(job['segments']):06d}.pending.mkv"
                        pending_files = set(manifest.parent.glob('.segment-*.pending.mkv'))
                        pending_files.add(expected_pending)
                        candidate_paths = set(pending_files)
                        if job.get('state') == 'finalizing':
                            candidate_paths.add(manifest.parent / '.concat.txt')
                        recovered_pids = set()
                        for path in candidate_paths:
                            for pid in self.processes_for_path(path):
                                if pid not in recovered_pids:
                                    self.kill_pid(pid)
                                    recovered_pids.add(pid)
                        for pending in pending_files:
                            pending.unlink(missing_ok=True)
                        if job.get('state') == 'finalizing':
                            (manifest.parent / '.concat.txt').unlink(missing_ok=True)
                            self._remove_pending_output(job_id)
                            job['state'] = 'ready'
                        elif recovered_pids:
                            job['state'] = 'paused'
                        if recovered_pids:
                            report['recovered'] += len(recovered_pids)
                            job['error'] = 'Recovered an encoder left by an interrupted server'
                        if recovered_pids or job.get('state') == 'ready':
                            self._save(manifest, job)
                        continue
                    pid = int(encoder.get('pid', 0))
                    pending = Path(str(encoder.get('pendingPath', ''))).resolve()
                    expected_parent = manifest.parent.resolve()
                    if (pid < 1 or pending.parent != expected_parent
                            or not pending.name.startswith('.segment-')
                            or not pending.name.endswith('.pending.mkv')):
                        raise ValueError('Persisted encoder ownership is invalid')
                    command = self.process_command(pid)
                    verified = self._is_encoder_command(
                        command, pending, encoder.get('executable'))
                    if verified:
                        self.kill_pid(pid)
                        report['recovered'] += 1
                        reason = 'Recovered a stale encoder left by an interrupted server'
                    elif command:
                        report['refused'] += 1
                        reason = 'Stale encoder PID was reused; unrelated process was not stopped'
                    else:
                        report['alreadyExited'] += 1
                        reason = 'Recovered an interrupted encoder that had already exited'
                    pending.unlink(missing_ok=True)
                    job.pop('activeEncoder', None)
                    job['state'] = 'paused'
                    job['error'] = reason
                    self._save(manifest, job)
            except Exception:
                recovered = set()
                if recovery_lock is None and self.server_owner and manifest_hint:
                    try:
                        for pid in self.processes_for_path(manifest_hint.parent):
                            if pid not in recovered:
                                self.kill_pid(pid)
                                recovered.add(pid)
                    except Exception:
                        recovered.clear()
                if recovered:
                    report['recovered'] += len(recovered)
                else:
                    report['failed'] += 1
                continue
            finally:
                if recovery_lock:
                    try:
                        fcntl.flock(recovery_lock.fileno(), fcntl.LOCK_UN)
                    except OSError:
                        report['failed'] += 1
                    finally:
                        try:
                            recovery_lock.close()
                        except OSError:
                            report['failed'] += 1
        self.last_recovery = report
        return dict(report)

    def _job_lock(self, job_id):
        with self.lock:
            return self.job_locks.setdefault(job_id, threading.RLock())

    def _read_index(self):
        if not self.index_path.is_file():
            return {'schemaVersion': SCHEMA_VERSION, 'jobs': {}}
        try:
            value = json.loads(self.index_path.read_text())
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f'Video job index is unreadable: {error}') from error
        if value.get('schemaVersion') != SCHEMA_VERSION or not isinstance(value.get('jobs'), dict):
            raise ValueError('Video job index has an unsupported schema')
        return value

    def _write_index(self, value):
        atomic_write_json(self.index_path, value)

    def _manifest_path(self, job_id):
        if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise ValueError('Invalid video export id')
        index = self._read_index()
        entry = index['jobs'].get(job_id)
        if not isinstance(entry, dict) or not isinstance(entry.get('manifest'), str):
            raise ValueError('Video export is missing or already complete')
        return Path(entry['manifest'])

    def _load(self, job_id):
        path = self._manifest_path(job_id)
        try:
            value = json.loads(path.read_text())
        except FileNotFoundError as error:
            raise ValueError('Video export scratch storage is not available') from error
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f'Video export manifest is unreadable: {error}') from error
        if (value.get('schemaVersion') != SCHEMA_VERSION or value.get('id') != job_id
                or not isinstance(value.get('request'), dict)
                or not isinstance(value.get('segments'), list)
                or not isinstance(value.get('nextFrame'), int)
                or not isinstance(value.get('scratchPath'), str)
                or not isinstance(value.get('createdAt'), str)
                or not isinstance(value.get('updatedAt'), str)
                or not isinstance(value.get('state'), str)
                or not isinstance(value['request'].get('frames'), int)):
            raise ValueError('Video export manifest has an unsupported schema')
        return path, value

    def _save(self, path, job):
        job['updatedAt'] = utc_now()
        atomic_write_json(path, job)

    def _public(self, path, job):
        request = job['request']
        return {
            'id': job['id'],
            'state': job['state'],
            'reason': job.get('error'),
            'manifestPath': str(path),
            'scratchPath': job['scratchPath'],
            'nextFrame': job['nextFrame'],
            'frames': request['frames'],
            'segments': list(job['segments']),
            'request': request,
            'createdAt': job['createdAt'],
            'updatedAt': job['updatedAt'],
        }

    def create(self, request):
        if not isinstance(request, dict):
            raise ValueError('Video export request must be an object')
        fps = int(request.get('fps', 0))
        frames = int(request.get('frames', 0))
        checkpoint_seconds = int(request.get('checkpointSeconds', 60))
        if fps < 1 or frames < 1:
            raise ValueError('Video export requires positive fps and frame count')
        if checkpoint_seconds < 1 or checkpoint_seconds > 3600:
            raise ValueError('Checkpoint duration must be between 1 and 3,600 seconds')

        job_id = uuid.uuid4().hex
        configured_value = request.get('scratchPath')
        if configured_value is not None and not isinstance(configured_value, str):
            raise ValueError('Video scratch path must be text')
        configured = str(configured_value or '').strip()
        if configured:
            supplied = Path(configured).expanduser()
            if not supplied.is_absolute():
                raise ValueError('Video scratch path must be absolute')
            scratch_base = supplied.resolve()
            if not scratch_base.is_dir():
                raise ValueError('Video scratch path must already exist and be a directory')
        else:
            scratch_base = (self.videos / '.checkpoints').resolve()
            scratch_base.mkdir(parents=True, exist_ok=True)
        job_dir = scratch_base / job_id
        job_dir.mkdir(exist_ok=False)
        now = utc_now()
        normalized = {
            **request,
            'fps': fps,
            'frames': frames,
            'checkpointSeconds': checkpoint_seconds,
            'scratchPath': str(scratch_base),
        }
        job = {
            'schemaVersion': SCHEMA_VERSION,
            'id': job_id,
            'state': 'paused',
            'request': normalized,
            'scratchPath': str(scratch_base),
            'nextFrame': 0,
            'segments': [],
            'resumeCount': 0,
            'error': None,
            'createdAt': now,
            'updatedAt': now,
        }
        manifest = job_dir / 'job.json'
        try:
            atomic_write_json(manifest, job)
            with self.lock:
                index = self._read_index()
                index['jobs'][job_id] = {'manifest': str(manifest)}
                self._write_index(index)
        except Exception:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise
        return self._public(manifest, job)

    def list_jobs(self):
        with self.lock:
            index = self._read_index()
        result = []
        for job_id, entry in index['jobs'].items():
            manifest = Path(entry.get('manifest', '')) if isinstance(entry, dict) else Path()
            try:
                if not isinstance(entry, dict):
                    raise ValueError('Video job index entry is invalid')
                _, job = self._load(job_id)
                result.append(self._public(manifest, job))
            except Exception as error:
                result.append({
                    'id': job_id,
                    'state': 'unavailable',
                    'reason': str(error),
                    'manifestPath': str(manifest),
                })
        return sorted(result, key=lambda item: item.get('createdAt', ''))

    def get(self, job_id):
        with self._job_lock(job_id):
            manifest, job = self._load(job_id)
            return self._public(manifest, job)

    def output_filename(self, job_id):
        manifest, job = self._load(job_id)
        return self._output_filename(job_id, job)

    @staticmethod
    def _output_filename(job_id, job):
        request = job['request']
        label = re.sub(r'[^a-zA-Z0-9_-]+', '-', str(request.get('name', 'tesseract')))
        label = label[:60].strip('-') or 'tesseract'
        try:
            created = datetime.fromisoformat(job['createdAt']).astimezone(timezone.utc)
        except (ValueError, TypeError):
            created = datetime.now(timezone.utc)
        timestamp = created.strftime('%Y%m%dT%H%M%SZ')
        return f"{label}-{timestamp}-{job_id[:8]}.{request.get('format', 'mp4')}"

    def _remove_pending_output(self, job_id):
        if not self.videos.is_dir():
            return
        for path in self.videos.glob(f'.*-{job_id[:8]}.pending.*'):
            path.unlink(missing_ok=True)

    def _verify_segments(self, manifest, job, repair=False):
        job_dir = manifest.parent.resolve()
        recorded = set()
        expected_first = 0
        for expected_index, segment in enumerate(job['segments']):
            if not isinstance(segment, dict):
                raise ValueError('Video checkpoint metadata is invalid')
            name = segment.get('file')
            match = SEGMENT_NAME.fullmatch(str(name))
            if not match or int(match.group(1)) != expected_index:
                raise ValueError('Video checkpoint sequence is invalid')
            path = (job_dir / name).resolve()
            if path.parent != job_dir:
                raise ValueError('Video checkpoint path escapes scratch storage')
            if segment.get('firstFrame') != expected_first:
                raise ValueError('Video checkpoint frame sequence is invalid')
            frames = int(segment.get('frames', 0))
            valid = (
                frames >= 1
                and path.is_file()
                and path.stat().st_size == segment.get('bytes')
                and sha256_file(path) == segment.get('sha256')
            )
            if not valid:
                if not repair:
                    raise ValueError(f'Video checkpoint integrity check failed: {name}')
                quarantine = job_dir / 'quarantine'
                quarantine.mkdir(exist_ok=True)
                for damaged in job['segments'][expected_index:]:
                    damaged_path = job_dir / str(damaged.get('file', ''))
                    if damaged_path.is_file() and damaged_path.parent.resolve() == job_dir:
                        damaged_path.replace(quarantine / damaged_path.name)
                lost = job['nextFrame'] - expected_first
                job['segments'] = job['segments'][:expected_index]
                job['nextFrame'] = expected_first
                job['state'] = 'paused'
                job['error'] = f'Checkpoint damage detected; {lost:,} frames will be rerendered'
                self._save(manifest, job)
                break
            expected_first += frames
            recorded.add(path)
        if expected_first != job['nextFrame']:
            raise ValueError('Video checkpoint frame total does not match the manifest')

        for path in job_dir.glob('.segment-*.pending.mkv'):
            path.unlink(missing_ok=True)
        for path in job_dir.glob('segment-*.mkv'):
            if path.resolve() not in recorded:
                path.unlink(missing_ok=True)

    def _acquire_owner(self, manifest, job_id):
        owner_path = manifest.parent / '.owner.lock'
        stream = owner_path.open('a+')
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            stream.close()
            raise ValueError('Video export is active in another server process') from error
        stream.seek(0)
        stream.truncate()
        stream.write(json.dumps({'pid': os.getpid(), 'leaseOwner': job_id}) + '\n')
        stream.flush()
        with self.lock:
            self.owners[job_id] = stream

    def _release_owner(self, job_id):
        with self.lock:
            stream = self.owners.pop(job_id, None)
        if stream:
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            finally:
                stream.close()

    def resume(self, job_id, render_context=None):
        with self.lock:
            if job_id in self.leases:
                raise ValueError('Video export is already active in another browser')
        self._interrupt_active_segment(job_id)
        with self._job_lock(job_id):
            manifest, job = self._load(job_id)
            self._remove_pending_output(job_id)
            if job.get('activeEncoder'):
                raise ValueError(
                    'Video encoder recovery is incomplete; retry preflight before resuming'
                )
            self._acquire_owner(manifest, job_id)
            lease = uuid.uuid4().hex
            try:
                with self.lock:
                    if job_id in self.leases:
                        raise ValueError('Video export is already active in another browser')
                    self.leases[job_id] = {'token': lease, 'lastActivity': self.clock()}
                self._verify_segments(manifest, job, repair=True)
                if job['nextFrame'] < job['request']['frames'] and render_context is not None:
                    source_url = render_context.get('sourceUrl')
                    render_signature = render_context.get('renderSignature')
                    if (not isinstance(source_url, str) or not source_url
                            or not isinstance(render_signature, str) or not render_signature
                            or source_url != job['request'].get('sourceUrl')
                            or render_signature != job['request'].get('renderSignature')):
                        raise ValueError(
                            'Current source URL and render settings do not match this export'
                        )
                job['state'] = 'active'
                job['error'] = None
                job['resumeCount'] = int(job.get('resumeCount', 0)) + 1
                self._save(manifest, job)
                result = self._public(manifest, job)
                result['lease'] = lease
                return result
            except Exception:
                with self.lock:
                    self.leases.pop(job_id, None)
                self._release_owner(job_id)
                raise

    def _interrupt_active_segment(self, job_id):
        with self.lock:
            runtime = self.active.pop(job_id, None)
            self.leases.pop(job_id, None)
        if not runtime:
            self._release_owner(job_id)
            return
        process = runtime.get('process')
        stopped = not process or process.poll() is not None
        if process and process.poll() is None:
            try:
                process.kill()
                process.wait(timeout=5)
                stopped = True
            except Exception:
                pass
        if stopped and process and process.stdin:
            try:
                process.stdin.close()
            except OSError:
                pass
        pending = runtime.get('pending')
        if pending:
            pending.unlink(missing_ok=True)
        runtime_job = runtime.get('job')
        runtime_manifest = runtime.get('manifest')
        if runtime_job and runtime_manifest:
            runtime_job.pop('activeEncoder', None)
            try:
                self._save(runtime_manifest, runtime_job)
            except OSError:
                pass
        self._release_owner(job_id)

    def pause(self, job_id, reason=None, lease=None):
        with self.lock:
            active_lease = self.leases.get(job_id)
            if lease is not None and (not active_lease or active_lease['token'] != lease):
                raise ValueError('Video export lease is no longer active')
        # Kill the encoder before taking the per-job lock. A frame writer may be
        # blocked in the pipe, and killing ffmpeg is what wakes that writer.
        self._interrupt_active_segment(job_id)
        with self._job_lock(job_id):
            manifest, job = self._load(job_id)
            for path in manifest.parent.glob('.segment-*.pending.mkv'):
                path.unlink(missing_ok=True)
            job.pop('activeEncoder', None)
            job['state'] = 'paused'
            job['error'] = job.get('error') or (str(reason) if reason else None)
            self._save(manifest, job)
            return self._public(manifest, job)

    def _start_segment(self, manifest, job, lease):
        segment_index = len(job['segments'])
        pending = manifest.parent / f'.segment-{segment_index:06d}.pending.mkv'
        request = job['request']
        bit_rate = int(request.get(
            'bitRate',
            int(request.get('width', 1280)) * int(request.get('height', 720))
            * int(request['fps']) * 0.07,
        ))
        checkpoint_bytes = max(1, bit_rate * int(request['checkpointSeconds']) // 8)
        free_bytes = shutil.disk_usage(manifest.parent).free
        if checkpoint_bytes > free_bytes * 0.9:
            raise ValueError(
                f'Not enough scratch space for the next checkpoint ({free_bytes:,} bytes free)'
            )
        command = [
            self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'image2pipe', '-framerate', str(request['fps']),
            '-vcodec', 'png', '-i', 'pipe:0', '-an',
            '-c:v', 'libx264', '-preset', 'medium',
            '-b:v', str(bit_rate), '-maxrate', str(round(bit_rate * 1.5)),
            '-bufsize', str(bit_rate * 2), '-pix_fmt', 'yuv420p',
            '-f', 'matroska', str(pending),
        ]
        process = self.popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        runtime = {
            'manifest': manifest,
            'job': job,
            'lease': lease,
            'process': process,
            'pending': pending,
            'firstFrame': job['nextFrame'],
            'written': 0,
        }
        with self.lock:
            self.active[job['id']] = runtime
        process_pid = getattr(process, 'pid', None)
        if process_pid is not None:
            job['activeEncoder'] = {
                'pid': int(process_pid),
                'executable': self.ffmpeg,
                'pendingPath': str(pending),
                'firstFrame': job['nextFrame'],
            }
        try:
            self._save(manifest, job)
        except Exception:
            self._interrupt_active_segment(job['id'])
            raise
        return runtime

    def _fail_active_segment(self, job_id, runtime, message):
        process = runtime['process']
        stopped = process.poll() is not None
        if process.poll() is None:
            try:
                process.kill()
                process.wait(timeout=5)
                stopped = True
            except Exception:
                pass
        if stopped and process.stdin:
            try:
                process.stdin.close()
            except OSError:
                pass
        if runtime.get('pending'):
            runtime['pending'].unlink(missing_ok=True)
        with self.lock:
            self.active.pop(job_id, None)
            self.leases.pop(job_id, None)
        self._release_owner(job_id)
        job = runtime['job']
        job.pop('activeEncoder', None)
        job['state'] = 'paused'
        job['error'] = message
        self._save(runtime['manifest'], job)

    def _finalize_segment(self, job_id, runtime):
        process = runtime['process']
        try:
            process.stdin.close()
            return_code = process.wait(timeout=600)
        except (OSError, subprocess.SubprocessError) as error:
            self._fail_active_segment(job_id, runtime, f'Checkpoint encoder failed: {error}')
            raise ValueError('Checkpoint encoder failed') from error
        if return_code != 0 or not runtime['pending'].is_file():
            self._fail_active_segment(job_id, runtime, 'Checkpoint encoder exited before finalizing the segment')
            raise ValueError('Checkpoint encoder failed')

        try:
            with runtime['pending'].open('rb') as stream:
                _durable_fsync(stream)
            segment_index = len(runtime['job']['segments'])
            final = runtime['manifest'].parent / f'segment-{segment_index:06d}.mkv'
            runtime['pending'].replace(final)
            _fsync_directory(final.parent)
            metadata = {
                'index': segment_index,
                'firstFrame': runtime['firstFrame'],
                'frames': runtime['written'],
                'file': final.name,
                'bytes': final.stat().st_size,
                'sha256': sha256_file(final),
            }
            job = runtime['job']
            job['segments'].append(metadata)
            job['nextFrame'] += runtime['written']
            job.pop('activeEncoder', None)
            job['state'] = 'ready' if job['nextFrame'] == job['request']['frames'] else 'active'
            job['error'] = None
            self._save(runtime['manifest'], job)
            runtime.update({
                'process': None,
                'pending': None,
                'firstFrame': job['nextFrame'],
                'written': 0,
            })
            with self.lock:
                self.active.pop(job_id, None)
            return metadata
        except OSError as error:
            self._fail_active_segment(job_id, runtime, f'Could not save checkpoint: {error}')
            raise ValueError(f'Could not save checkpoint: {error}') from error

    def write_poster(self, job_id, png, lease):
        with self._job_lock(job_id):
            with self.lock:
                lease_state = self.leases.get(job_id)
                if not lease_state or lease_state['token'] != lease:
                    raise ValueError('Video export lease is no longer active')
                lease_state['lastActivity'] = self.clock()
                runtime = self.active.get(job_id)
            manifest, job = self._load(job_id)
            if job['nextFrame'] != 0 or job['segments']:
                raise ValueError('Resume frame can only be saved before rendering starts')
            if runtime and int(runtime.get('written', 0)) > 0:
                raise ValueError('Resume frame can only be saved before rendering starts')
            request = job['request']
            self.videos.mkdir(parents=True, exist_ok=True)
            final_path = self.videos / Path(self.output_filename(job_id)).with_suffix('.png')
            pending_path = self.videos / f'.{final_path.name}.pending'
            try:
                with pending_path.open('wb') as stream:
                    stream.write(png)
                    _durable_fsync(stream)
                pending_path.replace(final_path)
                _fsync_directory(final_path.parent)
            except OSError as error:
                pending_path.unlink(missing_ok=True)
                raise ValueError(f'Could not save export poster: {error}') from error
            poster = {
                'file': final_path.name,
                'bytes': final_path.stat().st_size,
                'sha256': sha256_file(final_path),
                'width': request['width'],
                'height': request['height'],
            }
            job['poster'] = poster
            self._save(manifest, job)
            return {
                'url': '/' + final_path.relative_to(self.root).as_posix(),
                'filename': final_path.name,
                **{key: value for key, value in poster.items() if key != 'file'},
            }

    def write_frame(self, job_id, frame_index, png, lease):
        with self._job_lock(job_id):
            with self.lock:
                lease_state = self.leases.get(job_id)
                if not lease_state or lease_state['token'] != lease:
                    raise ValueError('Video export lease is no longer active')
                lease_state['lastActivity'] = self.clock()
                runtime = self.active.get(job_id)
            if runtime is None:
                manifest, job = self._load(job_id)
                runtime = self._start_segment(manifest, job, lease)
                with self.lock:
                    current = self.leases.get(job_id)
                    if not current or current['token'] != lease:
                        invalidated = True
                    else:
                        invalidated = False
                if invalidated:
                    self._interrupt_active_segment(job_id)
                    raise ValueError('Video export lease is no longer active')
            job = runtime['job']
            expected = job['nextFrame'] + runtime['written']
            if int(frame_index) != expected:
                raise ValueError(f'Expected frame {expected}, received {frame_index}')
            if expected >= job['request']['frames']:
                raise ValueError('Video export already received all frames')
            try:
                runtime['process'].stdin.write(png)
                runtime['process'].stdin.flush()
            except (BrokenPipeError, OSError) as error:
                self._fail_active_segment(job_id, runtime, f'Checkpoint encoder stopped: {error}')
                raise ValueError('Checkpoint encoder stopped before the segment completed') from error
            runtime['written'] += 1
            checkpoint_frames = job['request']['fps'] * job['request']['checkpointSeconds']
            complete = (runtime['written'] >= checkpoint_frames
                        or expected + 1 == job['request']['frames'])
            if complete:
                self._finalize_segment(job_id, runtime)
            return {
                'frame': expected + 1,
                'frames': job['request']['frames'],
                'durableFrame': job['nextFrame'],
                'checkpointed': complete,
            }

    def pause_stale_jobs(self, now=None):
        current = self.clock() if now is None else float(now)
        with self.lock:
            stale = [
                job_id for job_id, lease in self.leases.items()
                if current - lease['lastActivity'] >= self.idle_timeout
            ]
        for job_id in stale:
            try:
                self.pause(job_id, 'Export paused after five minutes without a frame')
            except Exception:
                pass
        return stale

    def pause_all(self):
        with self.lock:
            job_ids = set(self.leases) | set(self.active) | set(self.owners)
        for job_id in job_ids:
            try:
                self.pause(job_id, 'Local video server stopped')
            except Exception:
                pass

    def discard(self, job_id):
        self._interrupt_active_segment(job_id)
        with self._job_lock(job_id):
            if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
                raise ValueError('Invalid video export id')
            poster_path = None
            try:
                _, job = self._load(job_id)
                poster_path = self.videos / Path(
                    self._output_filename(job_id, job)
                ).with_suffix('.png')
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
                pass
            with self.lock:
                index = self._read_index()
                entry = index['jobs'].pop(job_id, None)
                self._write_index(index)
            if not entry:
                raise ValueError('Video export is missing or already complete')
            manifest = Path(entry.get('manifest', '')) if isinstance(entry, dict) else None
            if manifest:
                shutil.rmtree(manifest.parent, ignore_errors=True)
            if poster_path:
                poster_path.unlink(missing_ok=True)
                poster_path.with_name(f'.{poster_path.name}.pending').unlink(missing_ok=True)
            self._remove_pending_output(job_id)

    def finish(self, job_id):
        with self._job_lock(job_id):
            with self.lock:
                runtime = self.active.get(job_id)
                if runtime:
                    raise ValueError('Video export still has an active checkpoint')
                self.leases.pop(job_id, None)
            manifest, job = self._load(job_id)
            self._verify_segments(manifest, job)
            request = job['request']
            if job['nextFrame'] != request['frames']:
                raise ValueError(
                    f"Video export has {job['nextFrame']:,} of {request['frames']:,} durable frames"
                )
            video_format = request.get('format', 'mp4')
            if video_format not in ('mp4', 'mkv'):
                raise ValueError('Unsupported video format')
            with self.lock:
                owns_job = job_id in self.owners
            if not owns_job:
                self._acquire_owner(manifest, job_id)

            filename = self.output_filename(job_id)
            self.videos.mkdir(parents=True, exist_ok=True)
            final_path = self.videos / filename
            pending_path = self.videos / f'.{final_path.stem}.pending{final_path.suffix}'
            concat_path = manifest.parent / '.concat.txt'
            concat_lines = []
            for segment in job['segments']:
                path = (manifest.parent / segment['file']).resolve()
                escaped = str(path).replace("'", "'\\''")
                concat_lines.append(f"file '{escaped}'\n")
            concat_path.write_text(''.join(concat_lines))

            output_args = (['-movflags', '+faststart'] if video_format == 'mp4'
                           else ['-f', 'matroska'])
            command = [
                self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
                '-f', 'concat', '-safe', '0', '-i', str(concat_path),
                '-c', 'copy', *output_args, str(pending_path),
            ]
            job['state'] = 'finalizing'
            job['error'] = None
            self._save(manifest, job)
            try:
                total_bytes = sum(segment['bytes'] for segment in job['segments'])
                free_bytes = shutil.disk_usage(self.videos).free
                if total_bytes > free_bytes * 0.9:
                    raise ValueError(
                        f'Not enough output space to finalize video ({free_bytes:,} bytes free)'
                    )
                completed = self.run(
                    command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    timeout=max(3600, total_bytes // 1_000_000),
                )
                if completed.returncode != 0 or not pending_path.is_file():
                    detail = (getattr(completed, 'stderr', b'') or b'').decode(errors='replace')[-4096:].strip()
                    raise ValueError(f'ffmpeg could not finalize checkpointed video{": " + detail if detail else ""}')
                with pending_path.open('rb') as stream:
                    _durable_fsync(stream)
                pending_path.replace(final_path)
                _fsync_directory(final_path.parent)
                request_metadata = dict(request)
                request_metadata.pop('scratchPath', None)
                metadata = {
                    **request_metadata,
                    'schemaVersion': 2,
                    'createdAt': job['createdAt'],
                    'completedAt': utc_now(),
                    'file': final_path.name,
                    'bytes': final_path.stat().st_size,
                    'checkpointSeconds': request['checkpointSeconds'],
                    'resumeCount': job.get('resumeCount', 0),
                    'segments': job['segments'],
                    **({'poster': job['poster']} if job.get('poster') else {}),
                }
                atomic_write_json(final_path.with_suffix('.json'), metadata)
            except (OSError, subprocess.SubprocessError, ValueError) as error:
                pending_path.unlink(missing_ok=True)
                job['state'] = 'ready'
                job['error'] = str(error)
                self._save(manifest, job)
                self._release_owner(job_id)
                if isinstance(error, ValueError):
                    raise ValueError(f'Could not finalize video: {error}') from error
                raise ValueError(f'Could not finalize video: {error}') from error
            finally:
                concat_path.unlink(missing_ok=True)

            with self.lock:
                index = self._read_index()
                index['jobs'].pop(job_id, None)
                self._write_index(index)
                self.job_locks.pop(job_id, None)
            self._release_owner(job_id)
            shutil.rmtree(manifest.parent, ignore_errors=True)
            return {
                'url': '/' + final_path.relative_to(self.root).as_posix(),
                'filename': final_path.name,
                'bytes': final_path.stat().st_size,
            }
