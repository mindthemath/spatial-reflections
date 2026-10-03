"""Durable checkpoint storage for resumable browser-rendered video exports."""

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_VERSION = 1
SEGMENT_NAME = re.compile(r'segment-(\d{6})\.mkv')


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


def atomic_write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with temporary.open('x') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            try:
                os.fsync(stream.fileno())
            except OSError:
                pass
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
        self.popen = subprocess.Popen
        self.clock = time.monotonic

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
                or not isinstance(value.get('nextFrame'), int)):
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

        with self.lock:
            job_id = uuid.uuid4().hex
            configured = str(request.get('scratchPath') or '').strip()
            scratch_base = (Path(configured).expanduser() if configured
                            else self.videos / '.checkpoints').resolve()
            job_dir = scratch_base / job_id
            job_dir.mkdir(parents=True, exist_ok=False)
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
                manifest = Path(entry.get('manifest', ''))
                try:
                    _, job = self._load(job_id)
                    result.append(self._public(manifest, job))
                except ValueError as error:
                    result.append({
                        'id': job_id,
                        'state': 'unavailable',
                        'reason': str(error),
                        'manifestPath': str(manifest),
                    })
            return sorted(result, key=lambda item: item.get('createdAt', ''))

    def _verify_segments(self, manifest, job):
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
            if not path.is_file():
                raise ValueError(f'Video checkpoint is missing: {name}')
            if segment.get('firstFrame') != expected_first:
                raise ValueError('Video checkpoint frame sequence is invalid')
            frames = int(segment.get('frames', 0))
            if frames < 1 or path.stat().st_size != segment.get('bytes'):
                raise ValueError(f'Video checkpoint integrity check failed: {name}')
            if sha256_file(path) != segment.get('sha256'):
                raise ValueError(f'Video checkpoint integrity check failed: {name}')
            expected_first += frames
            recorded.add(path)
        if expected_first != job['nextFrame']:
            raise ValueError('Video checkpoint frame total does not match the manifest')

        for path in job_dir.glob('.segment-*.pending.mkv'):
            path.unlink(missing_ok=True)
        for path in job_dir.glob('segment-*.mkv'):
            if path.resolve() not in recorded:
                path.unlink(missing_ok=True)

    def resume(self, job_id):
        with self._job_lock(job_id), self.lock:
            if job_id in self.leases:
                raise ValueError('Video export is already active in another browser')
            manifest, job = self._load(job_id)
            self._verify_segments(manifest, job)
            lease = uuid.uuid4().hex
            self.leases[job_id] = {'token': lease, 'lastActivity': self.clock()}
            job['state'] = 'active'
            job['error'] = None
            job['resumeCount'] = int(job.get('resumeCount', 0)) + 1
            self._save(manifest, job)
            result = self._public(manifest, job)
            result['lease'] = lease
            return result

    def _interrupt_active_segment(self, job_id):
        with self.lock:
            runtime = self.active.pop(job_id, None)
            self.leases.pop(job_id, None)
        if not runtime:
            return
        process = runtime.get('process')
        if process and process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        runtime['pending'].unlink(missing_ok=True)

    def pause(self, job_id, reason=None, lease=None):
        with self.lock:
            active_lease = self.leases.get(job_id)
            if lease is not None and (not active_lease or active_lease['token'] != lease):
                raise ValueError('Video export lease is no longer active')
        # Kill the encoder before taking the per-job lock. A frame writer may be
        # blocked in the pipe, and killing ffmpeg is what wakes that writer.
        self._interrupt_active_segment(job_id)
        with self._job_lock(job_id), self.lock:
            manifest, job = self._load(job_id)
            for path in manifest.parent.glob('.segment-*.pending.mkv'):
                path.unlink(missing_ok=True)
            job['state'] = 'paused'
            job['error'] = str(reason) if reason else None
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
        return runtime

    def _fail_active_segment(self, job_id, runtime, message):
        process = runtime['process']
        if process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        runtime['pending'].unlink(missing_ok=True)
        with self.lock:
            self.active.pop(job_id, None)
            self.leases.pop(job_id, None)
        job = runtime['job']
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
                try:
                    os.fsync(stream.fileno())
                except OSError:
                    pass
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
            except ValueError:
                pass
        return stale

    def discard(self, job_id):
        self._interrupt_active_segment(job_id)
        with self._job_lock(job_id), self.lock:
            manifest, _job = self._load(job_id)
            shutil.rmtree(manifest.parent, ignore_errors=True)
            index = self._read_index()
            index['jobs'].pop(job_id, None)
            self._write_index(index)

    def finish(self, job_id):
        raise NotImplementedError('Video finalization is implemented with the checkpoint encoder')
