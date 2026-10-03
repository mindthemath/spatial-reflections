import hashlib
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


if __name__ == '__main__':
    unittest.main()
