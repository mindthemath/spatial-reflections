"""One-shot video encoding. No checkpoint store, manifests, hashes or resume."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone


if __package__:
    from .video_audio import mux_audio_args
    from .video_color import COLOR_PROFILE, browser_video_color_args
    from .video_encoding import h264_encoding_args
else:
    from video_audio import mux_audio_args
    from video_color import COLOR_PROFILE, browser_video_color_args
    from video_encoding import h264_encoding_args


class SimpleVideoBackend:
    mode = 'simple'
    recovery_running = False
    recovery_pending = False

    def __init__(self, root, ffmpeg):
        self.root = Path(root).resolve()
        self.videos = self.root / 'videos'
        self.ffmpeg = str(ffmpeg)
        self.lock = threading.RLock()
        self.jobs = {}
        self.server_owner = None
        self.popen = subprocess.Popen
        self.run = subprocess.run
        self.clock = time.monotonic
        self.last_recovery = dict.fromkeys(
            ('recovered', 'alreadyExited', 'refused', 'skippedActive', 'failed'), 0)
        self.last_recovery['indexFailed'] = False

    def claim_server(self):
        if self.server_owner is not None:
            return
        self.videos.mkdir(parents=True, exist_ok=True)
        stream = (self.videos / '.server.lock').open('a+')
        try:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            stream.close()
            raise ValueError('Another video server is already using this project')
        self.server_owner = stream

    def release_server(self):
        with self.lock:
            if self.jobs:
                raise ValueError('Cannot release project ownership while a simple export remains active')
            stream, self.server_owner = self.server_owner, None
        if stream:
            stream.close()

    def start(self, request):
        with self.lock:
            if self.jobs:
                raise ValueError('Simple mode allows one export at a time')
            self.claim_server()
            job_id = uuid.uuid4().hex
            label = re.sub(r'[^a-zA-Z0-9_-]+', '-', str(request.get('name', 'tesseract'))).strip('-')[:60] or 'tesseract'
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            filename = f"{label}-{stamp}-{job_id[:8]}.{request['format']}"
            directory = Path(tempfile.mkdtemp(prefix=f'.simple-{job_id}-', dir=self.videos))
            job = {'id': job_id, 'lease': uuid.uuid4().hex,
                   'request': {**request, 'colorProfile': COLOR_PROFILE},
                   'filename': filename, 'nextFrame': 0, 'state': 'active',
                   'createdAt': datetime.now(timezone.utc).isoformat(),
                   'process': None, 'directory': directory, 'lock': threading.RLock(),
                   'pending': directory / filename,
                   'stderr': directory / 'encoder.stderr',
                   'lastActivity': self.clock()}
            self.jobs[job_id] = job
            return {**self._public(job), 'lease': job['lease'], 'filename': filename}

    @staticmethod
    def _public(job):
        return {key: job[key] for key in ('id', 'request', 'nextFrame', 'state')}

    def _job(self, job_id, lease=None):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError('Simple export is missing or already stopped')
            if lease is not None and lease != job['lease']:
                raise ValueError('Video export lease is no longer active')
            return job

    def get(self, job_id):
        return self._public(self._job(job_id))

    def list_jobs(self):
        # Never expose resumable jobs or inspect the durable store in this mode.
        return []

    def resume(self, *_args, **_kwargs):
        raise ValueError('Simple mode has no resume; start a new export from frame 0')

    def _command(self, job):
        request = job['request']
        threads = os.environ.get('TESSERACT_TEST_ENCODER_THREADS')
        thread_args = []
        if threads:
            if not 1 <= int(threads) <= 4:
                raise ValueError('Test encoder threads must be between 1 and 4')
            thread_args = ['-threads', str(int(threads))]
        container = (['-movflags', '+faststart'] if request['format'] == 'mp4'
                     else ['-f', 'matroska'])
        return [self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-xerror',
                *(['-filter_threads', '1'] if thread_args else []), *thread_args,
                '-f', 'image2pipe', '-framerate', str(request['fps']), '-vcodec', 'png',
                '-i', 'pipe:0', '-an',
                *browser_video_color_args(),
                *h264_encoding_args(request, thread_args),
                *container, str(job['pending'])]

    @staticmethod
    def _diagnostic(job):
        try:
            with job['stderr'].open('rb') as stream:
                stream.seek(max(0, job['stderr'].stat().st_size - 4096))
                return stream.read().decode(errors='replace').strip()
        except OSError:
            return ''

    def write_poster(self, job_id, png, lease):
        job = self._job(job_id, lease)
        with job['lock']:
            if job['state'] != 'active' or job['nextFrame'] != 0:
                raise ValueError('Starting frame can only be saved before rendering starts')
            filename = Path(job['filename']).with_suffix('.png').name
            path = job['directory'] / filename
            path.write_bytes(png)
            with self.lock:
                if job['state'] != 'active':
                    raise ValueError('Simple export was cancelled')
                job['poster'] = {'file': filename, 'bytes': len(png),
                                 'width': job['request']['width'], 'height': job['request']['height']}
                job['lastActivity'] = self.clock()
            return {'url': f'/videos/{filename}', 'filename': filename,
                    **{key: value for key, value in job['poster'].items() if key != 'file'}}

    def write_audio(self, job_id, wave, lease, details):
        job = self._job(job_id, lease)
        with job['lock']:
            if not job['request'].get('music', {}).get('enabled'):
                raise ValueError('This video export does not include a soundtrack')
            if job['state'] != 'active' or job['nextFrame'] != 0 or job['process'] is not None:
                raise ValueError('Soundtrack can only be saved before rendering starts')
            path = job['directory'] / 'soundtrack.wav'
            if path.exists():
                raise ValueError('Soundtrack has already been uploaded')
            path.write_bytes(wave)
            job['audio'] = {**details, 'file': path.name,
                            'sha256': hashlib.sha256(wave).hexdigest(), 'codec': 'pcm_s16le'}
            job['lastActivity'] = self.clock()
            return {key: value for key, value in job['audio'].items() if key != 'file'}

    def write_frame(self, job_id, frame_index, data, lease=None):
        job = self._job(job_id, lease)
        with job['lock']:
            if job['state'] != 'active':
                raise ValueError('Simple export is stopping or finalizing')
            if job['request'].get('music', {}).get('enabled') and 'audio' not in job:
                raise ValueError('Upload the soundtrack before video frames')
            if int(frame_index) != job['nextFrame'] or job['nextFrame'] >= job['request']['frames']:
                raise ValueError(f"Expected frame {job['nextFrame']}, received {frame_index}")
            try:
                with self.lock:
                    if job['state'] != 'active':
                        raise ValueError('Simple export is stopping')
                    if job['process'] is None:
                        with job['stderr'].open('xb') as stderr:
                            job['process'] = self.popen(self._command(job), stdin=subprocess.PIPE,
                                                        stdout=subprocess.DEVNULL, stderr=stderr)
                process = job['process']
                if process.poll() is not None:
                    raise ValueError('Encoder exited before this frame')
                process.stdin.write(data)
                process.stdin.flush()
                with self.lock:
                    if job['state'] != 'active':
                        raise ValueError('Simple export was cancelled')
                    job['nextFrame'] += 1
                    job['lastActivity'] = self.clock()
                return {'frame': job['nextFrame'], 'frames': job['request']['frames'],
                        'durableFrame': 0, 'checkpointed': False}
            except (OSError, ValueError) as error:
                detail = self._diagnostic(job)
                self.discard(job_id)
                raise ValueError(f'Simple export failed; partial output discarded: {error}'
                                 + (f': {detail}' if detail else '')) from error

    def finish(self, job_id):
        job = self._job(job_id)
        with job['lock']:
            with self.lock:
                if job['state'] != 'active' or job['nextFrame'] != job['request']['frames']:
                    raise ValueError('Simple export has not received all frames or is stopping')
                job['state'] = 'finalizing'
            published = []
            try:
                process = job['process']
                process.stdin.close()
                if process.wait(timeout=600) != 0:
                    raise ValueError(self._diagnostic(job) or 'Encoder finalization failed')
                if not job['pending'].is_file() or not job['pending'].stat().st_size:
                    raise ValueError('Encoder produced no output')
                if job['request'].get('music', {}).get('enabled'):
                    if 'audio' not in job:
                        raise ValueError('Soundtrack was not uploaded')
                    audio_path = job['directory'] / job['audio']['file']
                    muxed = job['directory'] / f'.mux-{job["filename"]}'
                    duration = job['request']['frames'] / job['request']['fps']
                    container = (['-movflags', '+faststart'] if job['request']['format'] == 'mp4'
                                 else ['-f', 'matroska'])
                    command = [self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
                               '-i', str(job['pending']),
                               *mux_audio_args(audio_path, duration), *container, str(muxed)]
                    completed = self.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                         timeout=max(600, round(duration * 2)))
                    if completed.returncode != 0 or not muxed.is_file() or not muxed.stat().st_size:
                        detail = (completed.stderr or b'').decode(errors='replace')[-4096:].strip()
                        raise ValueError(f'Could not mux soundtrack{": " + detail if detail else ""}')
                    muxed.replace(job['pending'])
                size = job['pending'].stat().st_size
                metadata_path = job['pending'].with_suffix('.json')
                request_metadata = dict(job['request'])
                request_metadata.pop('scratchPath', None)
                metadata = {**request_metadata, 'schemaVersion': 2, 'videoMode': 'simple',
                            'createdAt': job['createdAt'],
                            'completedAt': datetime.now(timezone.utc).isoformat(),
                            'file': job['filename'], 'bytes': size, 'resumeCount': 0,
                            **({'poster': job['poster']} if 'poster' in job else {}),
                            **({'audio': {key: value for key, value in job['audio'].items() if key != 'file'}}
                               if 'audio' in job else {})}
                metadata_path.write_text(json.dumps(metadata, indent=2), encoding='utf-8')
                artifacts = ([job['directory'] / job['poster']['file']] if 'poster' in job else [])
                artifacts += [metadata_path, job['pending']]
                with self.lock:
                    if job['state'] != 'finalizing':
                        raise ValueError('Simple export was cancelled before publishing')
                    # Publish the movie last, with its reproducibility artifacts
                    # already present. Roll back only our own links on failure.
                    for source in artifacts:
                        destination = self.videos / source.name
                        os.link(source, destination)
                        published.append(destination)
                    job['state'] = 'complete'
                self._remove(job)
                return {'filename': job['filename'], 'url': f"/videos/{job['filename']}", 'bytes': size}
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                for path in reversed(published):
                    path.unlink(missing_ok=True)
                self.discard(job_id)
                raise ValueError(f'Simple finalization failed: {error}; restart from frame 0') from error

    def _remove(self, job):
        try:
            shutil.rmtree(job['directory'])
        except FileNotFoundError:
            pass
        except OSError:
            if job['state'] != 'complete':
                raise
            # Publication succeeded. A leftover private directory must not turn
            # a completed movie into a false failure or block the next export.
        with self.lock:
            self.jobs.pop(job['id'], None)

    def discard(self, job_id, *, _idle_before=None):
        if not isinstance(job_id, str) or not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise ValueError('Invalid video export id')
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return
            if job['state'] == 'complete':
                return  # Publication already won; never remove a completed clip.
            if _idle_before is not None and (job['state'] != 'active' or job['lastActivity'] > _idle_before):
                return
            job['state'] = 'cancelled'
            process = job['process']
        # Stop first to wake a blocked pipe writer; never wait on its lock first.
        if process and process.poll() is None:
            try:
                process.kill()
                process.wait(timeout=5)
            except (OSError, subprocess.SubprocessError) as error:
                raise ValueError('Encoder could not be stopped; retry cancellation') from error
        with job['lock']:
            if process and process.stdin and not process.stdin.closed:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            self._remove(job)

    def pause(self, job_id, reason=None, lease=None):
        with self.lock:
            exists = job_id in self.jobs
        if exists:
            self._job(job_id, lease)
        self.discard(job_id)
        return {'id': job_id, 'state': 'cancelled'}

    def pause_all(self):
        with self.lock:
            ids = list(self.jobs)
        for job_id in ids:
            self.discard(job_id)

    def pause_stale_jobs(self):
        with self.lock:
            cutoff = self.clock() - 300
            ids = [job['id'] for job in self.jobs.values()
                   if job['state'] == 'active' and job['lastActivity'] <= cutoff]
        for job_id in ids:
            self.discard(job_id, _idle_before=cutoff)
        return ids
