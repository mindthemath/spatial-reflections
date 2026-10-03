import hashlib
import io
import json
import shutil
import tempfile
import threading
import types
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
        self.store.pause_all()
        self.temp.cleanup()

    def manifest(self, job):
        return Path(job['manifestPath'])

    def write_manifest(self, job, value):
        self.manifest(job).write_text(json.dumps(value))

    def ready_job(self, video_format='mp4'):
        job = self.store.create(request(
            name=f'finished {video_format}', fps=1, frames=2,
            checkpointSeconds=1, format=video_format,
        ))
        manifest_path = self.manifest(job)
        manifest = json.loads(manifest_path.read_text())
        segments = []
        for index, content in enumerate((b'first', b'second')):
            path = manifest_path.parent / f'segment-{index:06d}.mkv'
            path.write_bytes(content)
            segments.append({
                'index': index,
                'firstFrame': index,
                'frames': 1,
                'file': path.name,
                'bytes': len(content),
                'sha256': hashlib.sha256(content).hexdigest(),
            })
        manifest.update({'segments': segments, 'nextFrame': 2, 'state': 'ready', 'resumeCount': 3})
        self.write_manifest(job, manifest)
        return job

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
        scratch.mkdir(parents=True)
        created = self.store.create(request(scratchPath=str(scratch)))
        recreated = VideoJobStore(self.root, '/fake/ffmpeg')
        jobs = recreated.list_jobs()
        self.assertEqual([job['id'] for job in jobs], [created['id']])
        self.assertEqual(jobs[0]['scratchPath'], str(scratch.resolve()))
        self.assertEqual(jobs[0]['nextFrame'], 0)

    def test_missing_custom_scratch_is_reported_unavailable(self):
        scratch = self.root / 'mounted-share'
        scratch.mkdir()
        created = self.store.create(request(scratchPath=str(scratch)))
        manifest = self.manifest(created)
        for path in manifest.parent.iterdir():
            path.unlink()
        manifest.parent.rmdir()
        scratch.rmdir()
        jobs = VideoJobStore(self.root, '/fake/ffmpeg').list_jobs()
        self.assertEqual(jobs[0]['state'], 'unavailable')
        self.assertIn('not available', jobs[0]['reason'])

    def test_resume_rolls_back_missing_recorded_segment(self):
        job = self.store.create(request())
        manifest = json.loads(self.manifest(job).read_text())
        manifest['segments'] = [{
            'index': 0, 'firstFrame': 0, 'frames': 1800,
            'file': 'segment-000000.mkv', 'bytes': 5, 'sha256': '0' * 64,
        }]
        manifest['nextFrame'] = 1800
        self.write_manifest(job, manifest)
        resumed = self.store.resume(job['id'])
        self.assertEqual(resumed['nextFrame'], 0)
        self.assertEqual(resumed['segments'], [])

    def test_resume_rolls_back_hash_mismatched_segment(self):
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
        resumed = self.store.resume(job['id'])
        self.assertEqual(resumed['nextFrame'], 0)
        self.assertFalse(segment.exists())
        self.assertTrue((self.manifest(job).parent / 'quarantine' / segment.name).exists())

    def test_custom_scratch_must_be_existing_absolute_directory(self):
        with self.assertRaisesRegex(ValueError, 'absolute'):
            self.store.create(request(scratchPath='relative/scratch'))
        missing = self.root / 'not-mounted'
        with self.assertRaisesRegex(ValueError, 'already exist'):
            self.store.create(request(scratchPath=str(missing)))

    def test_malformed_job_does_not_hide_healthy_jobs(self):
        healthy = self.store.create(request())
        malformed_id = 'f' * 32
        index = json.loads(self.store.index_path.read_text())
        index['jobs'][malformed_id] = 'not-an-object'
        self.store.index_path.write_text(json.dumps(index))
        jobs = self.store.list_jobs()
        self.assertEqual(len(jobs), 2)
        self.assertEqual(next(job for job in jobs if job['id'] == healthy['id'])['state'], 'paused')
        self.assertEqual(next(job for job in jobs if job['id'] == malformed_id)['state'], 'unavailable')

    def test_discard_removes_unavailable_job_from_index(self):
        scratch = self.root / 'mounted'
        scratch.mkdir()
        job = self.store.create(request(scratchPath=str(scratch)))
        shutil.rmtree(scratch)
        self.store.discard(job['id'])
        self.assertEqual(self.store.list_jobs(), [])

    def test_second_store_cannot_claim_same_job(self):
        job = self.store.create(request())
        first = self.store.resume(job['id'])
        other = VideoJobStore(self.root, '/fake/ffmpeg')
        with self.assertRaisesRegex(ValueError, 'another server'):
            other.resume(job['id'])
        self.store.pause(job['id'], lease=first['lease'])
        claimed = other.resume(job['id'])
        other.pause(job['id'], lease=claimed['lease'])

    def test_resume_cleans_orphaned_active_encoder(self):
        class Orphan:
            def __init__(self):
                self.stdin = io.BytesIO()
                self.killed = False
            def poll(self):
                return None
            def kill(self):
                self.killed = True
            def wait(self, timeout=None):
                return 0

        job = self.store.create(request())
        process = Orphan()
        pending = self.manifest(job).parent / '.segment-000000.pending.mkv'
        pending.write_bytes(b'partial')
        self.store.active[job['id']] = {'process': process, 'pending': pending}
        resumed = self.store.resume(job['id'])
        self.assertTrue(process.killed)
        self.assertFalse(pending.exists())
        self.store.pause(job['id'], lease=resumed['lease'])

    def test_pause_racing_first_frame_does_not_leave_encoder(self):
        registered = threading.Event()
        continue_write = threading.Event()
        killed = threading.Event()

        class WaitingProcess:
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.returncode = None
                self.output = Path(command[-1])
            def poll(self):
                return self.returncode
            def kill(self):
                self.returncode = -9
                killed.set()
            def wait(self, timeout=None):
                return self.returncode

        self.store.popen = WaitingProcess
        original_start = self.store._start_segment

        def delayed_start(*args):
            runtime = original_start(*args)
            registered.set()
            continue_write.wait(2)
            return runtime

        self.store._start_segment = delayed_start
        job = self.store.create(request())
        active = self.store.resume(job['id'])
        write_errors = []
        writer = threading.Thread(target=lambda: self._capture_error(
            write_errors,
            lambda: self.store.write_frame(job['id'], 0, b'png', active['lease'])))
        writer.start()
        self.assertTrue(registered.wait(2))
        pauser = threading.Thread(target=lambda: self.store.pause(
            job['id'], 'navigation', active['lease']))
        pauser.start()
        self.assertTrue(killed.wait(2))
        continue_write.set()
        writer.join(2)
        pauser.join(2)
        self.assertFalse(writer.is_alive())
        self.assertFalse(pauser.is_alive())
        self.assertRegex(str(write_errors[0]), 'lease')
        self.assertNotIn(job['id'], self.store.active)

    @staticmethod
    def _capture_error(errors, action):
        try:
            action()
        except Exception as error:
            errors.append(error)

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

    def test_finish_concats_segments_in_order_for_mp4_and_mkv(self):
        for video_format in ('mp4', 'mkv'):
            with self.subTest(video_format=video_format):
                root = self.root / video_format
                store = VideoJobStore(root, '/fake/ffmpeg')
                self.store = store
                job = self.ready_job(video_format)
                commands = []
                concat_inputs = []

                def run(command, **_kwargs):
                    commands.append(command)
                    concat_path = Path(command[command.index('-i') + 1])
                    concat_inputs.append(concat_path.read_text())
                    self.assertTrue(self.manifest(job).parent.is_dir())
                    Path(command[-1]).write_bytes(f'final-{video_format}'.encode())
                    return types.SimpleNamespace(returncode=0)

                store.run = run
                completed = store.finish(job['id'])
                self.assertTrue(completed['filename'].endswith(f'.{video_format}'))
                self.assertIn('segment-000000.mkv', concat_inputs[0])
                self.assertLess(concat_inputs[0].index('segment-000000.mkv'),
                                concat_inputs[0].index('segment-000001.mkv'))
                self.assertIn('-c', commands[0])
                self.assertIn('copy', commands[0])
                if video_format == 'mp4':
                    self.assertIn('+faststart', commands[0])
                else:
                    self.assertEqual(commands[0][-3:-1], ['-f', 'matroska'])
                output = root / completed['url'].lstrip('/')
                metadata = json.loads(output.with_suffix('.json').read_text())
                self.assertEqual(metadata['checkpointSeconds'], 1)
                self.assertEqual(metadata['resumeCount'], 3)
                self.assertEqual(len(metadata['segments']), 2)
                self.assertFalse(self.manifest(job).parent.exists())
                self.assertEqual(store.list_jobs(), [])

    def test_failed_finalization_preserves_segments_for_retry(self):
        job = self.ready_job('mp4')
        attempts = [0]

        def run(command, **_kwargs):
            attempts[0] += 1
            if attempts[0] == 1:
                return types.SimpleNamespace(returncode=1)
            Path(command[-1]).write_bytes(b'complete')
            return types.SimpleNamespace(returncode=0)

        self.store.run = run
        with self.assertRaisesRegex(ValueError, 'finalize'):
            self.store.finish(job['id'])
        self.assertTrue(self.manifest(job).parent.is_dir())
        self.assertEqual(len(list(self.manifest(job).parent.glob('segment-*.mkv'))), 2)
        self.assertEqual(self.store.list_jobs()[0]['state'], 'ready')
        completed = self.store.finish(job['id'])
        self.assertTrue((self.root / completed['url'].lstrip('/')).is_file())


if __name__ == '__main__':
    unittest.main()
