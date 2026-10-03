import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from studio.video_resume import VideoJobStore


def request(**overrides):
    value = {
        'name': 'long render',
        'width': 1280,
        'height': 720,
        'fps': 30,
        'frames': 5400,
        'quality': 'standard',
        'format': 'mp4',
        'checkpointSeconds': 60,
        'sourceUrl': '/?skybox=exports%2Ftest',
        'renderSignature': 'render-v1',
        'viewerState': {'shader': 'chrome'},
    }
    value.update(overrides)
    return value


class VideoJobStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.store = VideoJobStore(self.root, '/fake/ffmpeg')

    def tearDown(self):
        self.temp.cleanup()

    def manifest(self, job):
        return Path(job['manifestPath'])

    def write_manifest(self, job, value):
        self.manifest(job).write_text(json.dumps(value))

    def test_create_atomically_indexes_default_scratch_job(self):
        job = self.store.create(request())
        index_path = self.root / 'videos' / '.video-job-index.json'
        self.assertTrue(index_path.is_file())
        index = json.loads(index_path.read_text())
        self.assertEqual(index['schemaVersion'], 1)
        self.assertEqual(index['jobs'][job['id']]['manifest'], job['manifestPath'])
        self.assertTrue(self.manifest(job).is_file())
        self.assertEqual(list(index_path.parent.glob('*.tmp')), [])
        self.assertIn(self.root / 'videos' / '.checkpoints', self.manifest(job).parents)

    def test_custom_scratch_job_survives_store_recreation(self):
        scratch = self.root / 'mounted-share' / 'scratch'
        created = self.store.create(request(scratchPath=str(scratch)))
        recreated = VideoJobStore(self.root, '/fake/ffmpeg')
        jobs = recreated.list_jobs()
        self.assertEqual([job['id'] for job in jobs], [created['id']])
        self.assertEqual(jobs[0]['scratchPath'], str(scratch.resolve()))
        self.assertEqual(jobs[0]['nextFrame'], 0)

    def test_missing_custom_scratch_is_reported_unavailable(self):
        scratch = self.root / 'mounted-share'
        created = self.store.create(request(scratchPath=str(scratch)))
        manifest = self.manifest(created)
        for path in manifest.parent.iterdir():
            path.unlink()
        manifest.parent.rmdir()
        scratch.rmdir()
        jobs = VideoJobStore(self.root, '/fake/ffmpeg').list_jobs()
        self.assertEqual(jobs[0]['state'], 'unavailable')
        self.assertIn('not available', jobs[0]['reason'])

    def test_resume_rejects_missing_recorded_segment(self):
        job = self.store.create(request())
        manifest = json.loads(self.manifest(job).read_text())
        manifest['segments'] = [{
            'index': 0, 'firstFrame': 0, 'frames': 1800,
            'file': 'segment-000000.mkv', 'bytes': 5, 'sha256': '0' * 64,
        }]
        manifest['nextFrame'] = 1800
        self.write_manifest(job, manifest)
        with self.assertRaisesRegex(ValueError, 'missing'):
            self.store.resume(job['id'])

    def test_resume_rejects_hash_mismatched_segment(self):
        job = self.store.create(request())
        segment = self.manifest(job).parent / 'segment-000000.mkv'
        segment.write_bytes(b'actual')
        manifest = json.loads(self.manifest(job).read_text())
        manifest['segments'] = [{
            'index': 0, 'firstFrame': 0, 'frames': 1800,
            'file': segment.name, 'bytes': segment.stat().st_size,
            'sha256': hashlib.sha256(b'different').hexdigest(),
        }]
        manifest['nextFrame'] = 1800
        self.write_manifest(job, manifest)
        with self.assertRaisesRegex(ValueError, 'integrity'):
            self.store.resume(job['id'])

    def test_resume_removes_unrecorded_and_pending_segments(self):
        job = self.store.create(request())
        job_dir = self.manifest(job).parent
        (job_dir / 'segment-000000.mkv').write_bytes(b'unrecorded')
        (job_dir / '.segment-000000.pending.mkv').write_bytes(b'partial')
        resumed = self.store.resume(job['id'])
        self.assertEqual(resumed['nextFrame'], 0)
        self.assertFalse((job_dir / 'segment-000000.mkv').exists())
        self.assertFalse((job_dir / '.segment-000000.pending.mkv').exists())

    def test_checkpoint_closes_at_boundary_and_next_starts_lazily(self):
        processes = []

        class FakeProcess:
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.output = Path(command[-1])
                self.returncode = None
                processes.append(self)

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                self.output.write_bytes(b'segment-' + str(len(processes)).encode())
                self.returncode = 0
                return 0

            def kill(self):
                self.returncode = -9

        self.store.popen = FakeProcess
        job = self.store.create(request(fps=2, frames=6, checkpointSeconds=2))
        lease = self.store.resume(job['id'])['lease']
        for frame in range(3):
            progress = self.store.write_frame(job['id'], frame, b'png', lease)
            self.assertEqual(progress['durableFrame'], 0)
        progress = self.store.write_frame(job['id'], 3, b'png', lease)
        self.assertEqual(progress['durableFrame'], 4)
        self.assertTrue(progress['checkpointed'])
        self.assertEqual(len(processes), 1)
        persisted = json.loads(self.manifest(job).read_text())
        self.assertEqual(persisted['nextFrame'], 4)
        self.assertEqual(persisted['segments'][0]['frames'], 4)
        self.assertEqual(persisted['segments'][0]['firstFrame'], 0)
        self.store.write_frame(job['id'], 4, b'png', lease)
        self.assertEqual(len(processes), 2)

    def test_encoder_failure_pauses_at_last_durable_frame(self):
        class FailingProcess:
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.output = Path(command[-1])
                self.returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                self.returncode = 1
                return 1

            def kill(self):
                self.returncode = -9

        self.store.popen = FailingProcess
        job = self.store.create(request(fps=1, frames=2, checkpointSeconds=1))
        lease = self.store.resume(job['id'])['lease']
        with self.assertRaisesRegex(ValueError, 'encoder'):
            self.store.write_frame(job['id'], 0, b'png', lease)
        persisted = json.loads(self.manifest(job).read_text())
        self.assertEqual(persisted['state'], 'paused')
        self.assertEqual(persisted['nextFrame'], 0)
        self.assertEqual(persisted['segments'], [])

    def test_pause_discards_only_active_segment(self):
        class WaitingProcess:
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.output = Path(command[-1])
                self.output.write_bytes(b'partial')
                self.returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                return self.returncode

            def kill(self):
                self.returncode = -9

        self.store.popen = WaitingProcess
        job = self.store.create(request(fps=2, frames=8, checkpointSeconds=2))
        lease = self.store.resume(job['id'])['lease']
        self.store.write_frame(job['id'], 0, b'png', lease)
        self.store.write_frame(job['id'], 1, b'png', lease)
        paused = self.store.pause(job['id'], 'browser left', lease)
        self.assertEqual(paused['nextFrame'], 0)
        self.assertEqual(paused['state'], 'paused')
        self.assertEqual(list(self.manifest(job).parent.glob('*.pending.mkv')), [])

    def test_idle_job_is_paused_and_can_be_resumed(self):
        now = [10.0]
        self.store.clock = lambda: now[0]
        self.store.idle_timeout = 5
        job = self.store.create(request())
        self.store.resume(job['id'])
        now[0] = 16.0
        self.assertEqual(self.store.pause_stale_jobs(), [job['id']])
        self.assertEqual(self.store.resume(job['id'])['nextFrame'], 0)

    def test_second_resume_is_rejected_until_first_lease_pauses(self):
        job = self.store.create(request())
        active = self.store.resume(job['id'])
        with self.assertRaisesRegex(ValueError, 'already active'):
            self.store.resume(job['id'])
        self.store.pause(job['id'], lease=active['lease'])
        replacement = self.store.resume(job['id'])
        self.assertNotEqual(replacement['lease'], active['lease'])


if __name__ == '__main__':
    unittest.main()
