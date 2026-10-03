"""Durable checkpoint storage for resumable browser-rendered video exports."""

import hashlib
import json
import os
import re
import shutil
import threading
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
        with self.lock:
            manifest, job = self._load(job_id)
            self._verify_segments(manifest, job)
            job['state'] = 'paused'
            job['error'] = None
            job['resumeCount'] = int(job.get('resumeCount', 0)) + 1
            self._save(manifest, job)
            return self._public(manifest, job)

    def pause(self, job_id, reason=None):
        with self.lock:
            manifest, job = self._load(job_id)
            for path in manifest.parent.glob('.segment-*.pending.mkv'):
                path.unlink(missing_ok=True)
            job['state'] = 'paused'
            job['error'] = str(reason) if reason else None
            self._save(manifest, job)
            return self._public(manifest, job)

    def discard(self, job_id):
        with self.lock:
            manifest, _job = self._load(job_id)
            shutil.rmtree(manifest.parent, ignore_errors=True)
            index = self._read_index()
            index['jobs'].pop(job_id, None)
            self._write_index(index)

    def finish(self, job_id):
        raise NotImplementedError('Video finalization is implemented with the checkpoint encoder')
