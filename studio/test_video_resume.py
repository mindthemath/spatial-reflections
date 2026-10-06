import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import threading
import types
import unittest
from unittest import mock
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
        self.store.pause(job['id'], lease=resumed['lease'])
        self.store.discard(job['id'])
        self.assertEqual(self.store.list_jobs(), [])

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

    def test_claimed_server_recovery_reports_malformed_index_entry(self):
        malformed_id = 'f' * 32
        index = self.store._read_index()
        index['jobs'][malformed_id] = 'not-an-object'
        self.store._write_index(index)
        self.store.processes_for_path = lambda _path: []
        self.store.claim_server()
        try:
            report = self.store.recover_stale_encoders()
        finally:
            self.store.release_server()

        self.assertEqual(report['failed'], 1)
        self.assertFalse(report['indexFailed'])

    def test_discard_removes_unavailable_job_from_index(self):
        scratch = self.root / 'mounted'
        scratch.mkdir()
        job = self.store.create(request(scratchPath=str(scratch)))
        shutil.rmtree(scratch)
        self.store.discard(job['id'])
        self.assertEqual(self.store.list_jobs(), [])

    def test_discard_removes_poster_when_custom_scratch_is_missing(self):
        scratch = self.root / 'mounted-with-poster'
        scratch.mkdir()
        job = self.store.create(request(scratchPath=str(scratch)))
        active = self.store.resume(job['id'])
        poster = self.store.write_poster(job['id'], b'poster', active['lease'])
        poster_path = self.root / poster['url'].lstrip('/')
        self.store.pause(job['id'], lease=active['lease'])
        shutil.rmtree(scratch)

        self.store.discard(job['id'])

        self.assertFalse(poster_path.exists())

    def test_index_manifest_path_must_identify_exact_job_directory(self):
        job = self.store.create(request())
        index = json.loads(self.store.index_path.read_text())
        for invalid in ('', '.', str(self.root / 'unrelated' / 'job.json')):
            with self.subTest(invalid=invalid):
                index['jobs'][job['id']]['manifest'] = invalid
                self.store._write_index(index)
                with self.assertRaisesRegex(ValueError, 'index entry'):
                    self.store._manifest_path(job['id'])

    def test_discard_never_recursively_deletes_unverified_manifest_directory(self):
        job = self.store.create(request())
        unrelated = self.root / 'unrelated' / job['id']
        unrelated.mkdir(parents=True)
        (unrelated / 'job.json').write_text('{}')
        marker = unrelated / 'keep.txt'
        marker.write_text('keep')
        index = json.loads(self.store.index_path.read_text())
        index['jobs'][job['id']]['manifest'] = str(unrelated / 'job.json')
        self.store._write_index(index)

        with self.assertRaisesRegex(ValueError, 'unexpected entry'):
            self.store.discard(job['id'])

        self.assertEqual(marker.read_text(), 'keep')
        self.assertEqual(len(self.store.list_jobs()), 1)

    def test_second_store_cannot_claim_same_job(self):
        job = self.store.create(request())
        first = self.store.resume(job['id'])
        other = VideoJobStore(self.root, '/fake/ffmpeg')
        with self.assertRaisesRegex(ValueError, 'another server'):
            other.resume(job['id'])
        self.store.pause(job['id'], lease=first['lease'])
        claimed = other.resume(job['id'])
        other.pause(job['id'], lease=claimed['lease'])

    def test_only_one_server_can_own_video_root(self):
        self.store.claim_server()
        other = VideoJobStore(self.root, '/fake/ffmpeg')
        with self.assertRaisesRegex(ValueError, 'server'):
            other.claim_server()
        self.store.release_server()
        other.claim_server()
        other.release_server()

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
        manifest = json.loads(self.manifest(job).read_text())
        manifest['activeEncoder'] = {
            'pid': 4242, 'pendingPath': str(pending), 'firstFrame': 0,
        }
        self.write_manifest(job, manifest)
        self.store.active[job['id']] = {
            'process': process, 'pending': pending,
            'manifest': self.manifest(job), 'job': manifest,
        }
        resumed = self.store.resume(job['id'])
        self.assertTrue(process.killed)
        self.assertFalse(pending.exists())
        self.assertNotIn('activeEncoder', json.loads(self.manifest(job).read_text()))
        self.store.pause(job['id'], lease=resumed['lease'])

    def test_started_encoder_is_persisted_for_crash_recovery(self):
        class Process:
            pid = 4242
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.returncode = None
            def poll(self):
                return self.returncode
            def kill(self):
                self.returncode = -9
            def wait(self, timeout=None):
                return self.returncode

        self.store.popen = Process
        job = self.store.create(request())
        active = self.store.resume(job['id'])
        self.store.write_frame(job['id'], 0, b'png', active['lease'])
        persisted = json.loads(self.manifest(job).read_text())
        self.assertEqual(persisted['activeEncoder']['pid'], 4242)
        self.assertEqual(persisted['activeEncoder']['firstFrame'], 0)
        self.assertEqual(
            Path(persisted['activeEncoder']['pendingPath']).name,
            '.segment-000000.pending.mkv')

    def test_startup_reaps_only_verified_job_encoder(self):
        job = self.store.create(request())
        manifest_path = self.manifest(job)
        pending = manifest_path.parent / '.segment-000000.pending.mkv'
        pending.write_bytes(b'partial')
        manifest = json.loads(manifest_path.read_text())
        manifest['state'] = 'active'
        manifest['activeEncoder'] = {
            'pid': 4242,
            'pendingPath': str(pending),
            'firstFrame': 0,
        }
        self.write_manifest(job, manifest)

        recreated = VideoJobStore(self.root, '/fake/ffmpeg')
        killed = []
        recreated.process_command = lambda pid: f'/fake/ffmpeg -i pipe:0 {pending}'
        recreated.kill_pid = lambda pid: killed.append(pid)
        report = recreated.recover_stale_encoders()

        self.assertEqual(killed, [4242])
        self.assertEqual(report, {
            'recovered': 1, 'alreadyExited': 0, 'refused': 0,
            'skippedActive': 0, 'failed': 0, 'indexFailed': False,
        })
        recovered = json.loads(manifest_path.read_text())
        self.assertNotIn('activeEncoder', recovered)
        self.assertEqual(recovered['state'], 'paused')
        self.assertFalse(pending.exists())

    def test_startup_never_kills_reused_unrelated_pid(self):
        job = self.store.create(request())
        manifest_path = self.manifest(job)
        pending = manifest_path.parent / '.segment-000000.pending.mkv'
        pending.write_bytes(b'partial')
        manifest = json.loads(manifest_path.read_text())
        manifest['activeEncoder'] = {
            'pid': 4242,
            'pendingPath': str(pending),
            'firstFrame': 0,
        }
        self.write_manifest(job, manifest)

        recreated = VideoJobStore(self.root, '/fake/ffmpeg')
        killed = []
        recreated.process_command = lambda pid: f"/bin/bash -c '/fake/ffmpeg -i pipe:0 {pending}'"
        recreated.kill_pid = lambda pid: killed.append(pid)
        report = recreated.recover_stale_encoders()

        self.assertEqual(killed, [])
        self.assertEqual(report, {
            'recovered': 0, 'alreadyExited': 0, 'refused': 1,
            'skippedActive': 0, 'failed': 0, 'indexFailed': False,
        })
        recovered = json.loads(manifest_path.read_text())
        self.assertNotIn('activeEncoder', recovered)
        self.assertIn('PID was reused', recovered['error'])

    def test_startup_reaps_pre_tracking_encoder_by_exact_pending_path(self):
        job = self.store.create(request())
        manifest_path = self.manifest(job)
        pending = manifest_path.parent / '.segment-000000.pending.mkv'
        pending.write_bytes(b'legacy partial')

        recreated = VideoJobStore(self.root, '/fake/ffmpeg')
        killed = []
        recreated.processes_for_path = lambda path: [4242] if path == pending else []
        recreated.kill_pid = lambda pid: killed.append(pid)
        report = recreated.recover_stale_encoders()

        self.assertEqual(killed, [4242])
        self.assertEqual(report, {
            'recovered': 1, 'alreadyExited': 0, 'refused': 0,
            'skippedActive': 0, 'failed': 0, 'indexFailed': False,
        })
        self.assertFalse(pending.exists())

    def test_startup_reaps_encoder_when_custom_scratch_is_unmounted(self):
        scratch = self.root / 'mounted-share'
        scratch.mkdir()
        job = self.store.create(request(scratchPath=str(scratch)))
        job_dir = self.manifest(job).parent
        detached = self.root / 'detached-share'
        scratch.rename(detached)

        recreated = VideoJobStore(self.root, '/fake/ffmpeg')
        recreated.claim_server()
        killed = []
        recreated.processes_for_path = lambda path: [4242] if path == job_dir else []
        recreated.kill_pid = lambda pid: killed.append(pid)
        report = recreated.recover_stale_encoders()

        self.assertEqual(killed, [4242])
        self.assertEqual(report, {
            'recovered': 1, 'alreadyExited': 0, 'refused': 0,
            'skippedActive': 0, 'failed': 0, 'indexFailed': False,
        })
        recreated.release_server()

    def test_startup_skips_encoder_owned_by_live_store(self):
        class Process:
            pid = 4242
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.returncode = None
            def poll(self):
                return self.returncode
            def kill(self):
                self.returncode = -9
            def wait(self, timeout=None):
                return self.returncode

        self.store.popen = Process
        job = self.store.create(request())
        active = self.store.resume(job['id'])
        self.store.write_frame(job['id'], 0, b'png', active['lease'])
        recreated = VideoJobStore(self.root, '/fake/ffmpeg')
        killed = []
        recreated.process_command = lambda pid: '/fake/ffmpeg should-not-be-inspected'
        recreated.kill_pid = lambda pid: killed.append(pid)

        report = recreated.recover_stale_encoders()

        self.assertEqual(killed, [])
        self.assertEqual(report['skippedActive'], 1)
        self.assertIn('activeEncoder', json.loads(self.manifest(job).read_text()))

    def test_startup_recovery_reports_corrupt_index_without_raising(self):
        self.store.videos.mkdir()
        self.store.index_path.write_text('{broken')
        report = self.store.recover_stale_encoders()
        self.assertEqual(report['failed'], 1)
        self.assertTrue(report['indexFailed'])

    def test_startup_recovery_keeps_marker_when_process_inspection_fails(self):
        job = self.store.create(request())
        manifest_path = self.manifest(job)
        pending = manifest_path.parent / '.segment-000000.pending.mkv'
        pending.write_bytes(b'partial')
        manifest = json.loads(manifest_path.read_text())
        manifest['activeEncoder'] = {
            'pid': 4242, 'pendingPath': str(pending), 'firstFrame': 0,
        }
        self.write_manifest(job, manifest)
        recreated = VideoJobStore(self.root, '/fake/ffmpeg')
        recreated.process_command = lambda pid: (_ for _ in ()).throw(
            subprocess.TimeoutExpired(['ps'], 5))

        report = recreated.recover_stale_encoders()

        self.assertEqual(report['failed'], 1)
        self.assertIn('activeEncoder', json.loads(manifest_path.read_text()))
        self.assertTrue(pending.exists())
        with self.assertRaisesRegex(ValueError, 'recovery'):
            recreated.resume(job['id'])

    def test_startup_reaps_orphaned_finalizer(self):
        job = self.ready_job('mp4')
        manifest_path = self.manifest(job)
        manifest = json.loads(manifest_path.read_text())
        manifest['state'] = 'finalizing'
        self.write_manifest(job, manifest)
        concat = manifest_path.parent / '.concat.txt'
        concat.write_text('stale')
        pending_output = self.root / 'videos' / f".finished-mp4-20261003T000000Z-{job['id'][:8]}.pending.mp4"
        pending_output.write_bytes(b'partial output')
        killed = []
        self.store.processes_for_path = lambda path: [4242] if path == concat else []
        self.store.kill_pid = lambda pid: killed.append(pid)

        report = self.store.recover_stale_encoders()

        self.assertEqual(killed, [4242])
        self.assertEqual(report['recovered'], 1)
        self.assertEqual(json.loads(manifest_path.read_text())['state'], 'ready')
        self.assertFalse(pending_output.exists())

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

    def test_recovery_pauses_ownerless_active_jobs_without_encoder_markers(self):
        for complete in (False, True):
            job = self.ready_job() if complete else self.store.create(request())
            manifest = json.loads(self.manifest(job).read_text())
            manifest['state'] = 'active'
            self.write_manifest(job, manifest)
            self.store.processes_for_path = lambda _path: []
            self.store.recover_stale_encoders()
            recovered = self.store.get(job['id'])
            self.assertEqual(recovered['state'], 'paused')
            self.assertIn('interrupted export', recovered['reason'])
            self.assertEqual(recovered['nextFrame'], 2 if complete else 0)

    def test_failed_live_encoder_cleanup_requests_recovery_after_storage_heals(self):
        class Encoder:
            pid=23456
            def __init__(self,*_args,**_kwargs): self.stdin=io.BytesIO();self.returncode=None
            def poll(self): return self.returncode
            def kill(self): self.returncode=-9
            def wait(self,timeout=None): return self.returncode
        for action in ('pause','fail','unlink'):
            with self.subTest(action=action):
                self.store.popen=Encoder
                job=self.store.create(request());lease=self.store.resume(job['id'])['lease']
                self.store.write_frame(job['id'],0,b'png',lease)
                runtime=self.store.active[job['id']];stderr=runtime['stderrStream']
                self.assertIn('activeEncoder',json.loads(self.manifest(job).read_text()))
                if action=='unlink':
                    runtime['pending']=mock.Mock(unlink=mock.Mock(side_effect=OSError('scratch unplugged')))
                    with self.assertRaisesRegex(OSError,'scratch unplugged'): self.store.pause(job['id'],lease=lease)
                else:
                    with mock.patch.object(self.store,'_save',side_effect=OSError('scratch unplugged')):
                        with self.assertRaisesRegex(OSError,'scratch unplugged'):
                            if action=='pause': self.store.pause(job['id'],lease=lease)
                            else: self.store._fail_active_segment(job['id'],runtime,'encoder failed')
                self.assertTrue(self.store.recovery_pending);self.assertTrue(stderr.closed)
                self.assertNotIn(job['id'],self.store.owners);self.assertNotIn(job['id'],self.store.active)
                self.assertNotIn(job['id'],self.store.leases)
                # Restored mount: stale PID metadata is repaired without restart.
                self.store.processes_for_path=lambda _path: []
                self.store.process_command=lambda _pid: ''
                report=self.store.recover_stale_encoders();self.assertEqual(report['failed'],0)
                self.assertEqual(self.store.get(job['id'])['state'],'paused')
                self.store.resume(job['id']);self.store.pause(job['id'])

    def test_transient_start_marker_save_failure_leaves_job_paused(self):
        class Encoder:
            pid=23456
            def __init__(self,*_args,**_kwargs): self.stdin=io.BytesIO();self.returncode=None
            def poll(self): return self.returncode
            def kill(self): self.returncode=-9
            def wait(self,timeout=None): return self.returncode
        self.store.popen=Encoder
        job=self.store.create(request());lease=self.store.resume(job['id'])['lease']
        original=self.store._save;calls=[]
        def save(manifest,data):
            calls.append(True)
            if len(calls)==1: raise OSError('transient marker write failure')
            return original(manifest,data)
        with mock.patch.object(self.store,'_save',side_effect=save):
            with self.assertRaisesRegex(OSError,'transient marker'):
                self.store.write_frame(job['id'],0,b'png',lease)
        self.assertEqual(self.store.get(job['id'])['state'],'paused')
        self.assertNotIn(job['id'],self.store.owners);self.assertNotIn(job['id'],self.store.leases)
        self.store.resume(job['id']);self.store.pause(job['id'])

    def test_repair_requested_during_recovery_survives_report_publication(self):
        def scan():
            self.store.recovery_pending = True
            self.store.last_recovery = self.store._empty_recovery_report()
            return dict(self.store.last_recovery)
        with mock.patch.object(self.store, '_recover_stale_encoders', side_effect=scan):
            self.store.recover_stale_encoders()
        self.assertTrue(self.store.recovery_pending)
        self.store.recover_stale_encoders()
        self.assertFalse(self.store.recovery_pending)

    def test_overlapping_recovery_does_not_consume_pending_repair(self):
        self.store.recovery_pending = True
        self.store.recovery_running = True
        with self.store.recovery_lock, mock.patch.object(self.store, '_recover_stale_encoders') as scan:
            self.store.recover_stale_encoders()
            scan.assert_not_called()
            self.assertTrue(self.store.recovery_pending)
            self.assertTrue(self.store.recovery_running)
        self.store.recovery_running = False

    def test_recovery_does_not_rewrite_already_idle_manifests(self):
        self.store.create(request())
        self.ready_job()
        self.store.processes_for_path = lambda _path: []
        with mock.patch.object(self.store, '_save', side_effect=AssertionError('Unchanged recovery must not write')):
            report = self.store.recover_stale_encoders()
        self.assertEqual(report['failed'], 0)

    def test_failed_stop_of_late_starting_encoder_keeps_ownership_and_lease(self):
        spawning, release, interrupted = threading.Event(), threading.Event(), threading.Event()
        processes, errors = [], []
        class ResistantProcess:
            pid = 23456
            def __init__(self, *_args, **_kwargs):
                spawning.set();release.wait(2)
                self.stdin = io.BytesIO();self.returncode = None;self.resist = True
                processes.append(self)
            def poll(self): return self.returncode
            def kill(self):
                if self.resist: raise OSError('stuck scratch I/O')
                self.returncode = -9
            def wait(self, timeout=None): return self.returncode
        self.store.popen = ResistantProcess
        job = self.store.create(request())
        lease = self.store.resume(job['id'])['lease']
        original = self.store._interrupt_active_segment
        def interrupt(job_id):
            original(job_id)
            if threading.current_thread().name == 'late-pauser': interrupted.set()
        self.store._interrupt_active_segment = interrupt
        def invoke(action):
            try: action()
            except Exception as error: errors.append(error)
        writer = threading.Thread(target=lambda: invoke(lambda: self.store.write_frame(job['id'],0,b'png',lease)))
        pauser = threading.Thread(name='late-pauser',target=lambda: invoke(lambda: self.store.pause(job['id'],lease=lease)))
        writer.start();self.assertTrue(spawning.wait(2));pauser.start()
        try:
            self.assertTrue(interrupted.wait(2))
        finally:
            release.set();writer.join(2);pauser.join(2)
        self.assertFalse(writer.is_alive());self.assertFalse(pauser.is_alive())
        self.assertEqual(len(errors),2)
        self.assertTrue(all('could not be stopped' in str(error) for error in errors))
        self.assertIn(job['id'],self.store.active);self.assertIn(job['id'],self.store.owners)
        self.assertEqual(self.store.leases[job['id']]['token'],lease)
        self.assertIn('activeEncoder',json.loads(self.manifest(job).read_text()))
        processes[0].resist = False
        self.store.pause(job['id'],lease=lease)

    def test_failed_pause_or_discard_releases_idle_owner_for_retry(self):
        for operation, method in ((self.store.pause, '_save'), (self.store.pause, '_load'),
                                  (self.store.discard, '_remove_job_directory')):
            with self.subTest(operation=operation.__name__, failure=method):
                job = self.store.create(request())
                self.store.resume(job['id'])
                with mock.patch.object(self.store, method, side_effect=OSError('unmounted scratch')):
                    with self.assertRaisesRegex(OSError, 'unmounted'):
                        operation(job['id'])
                self.assertNotIn(job['id'], self.store.owners)
                self.assertNotIn(job['id'], self.store.leases)
                self.assertTrue(self.store.recovery_pending)
                # Mount restored: no false 'active in another server' lock conflict.
                resumed = self.store.resume(job['id'])
                self.assertTrue(resumed['lease'])
                self.store.pause(job['id'])

    def test_recovery_never_pauses_a_live_owner_between_checkpoints(self):
        job = self.store.create(request())
        self.store.resume(job['id'])
        other = VideoJobStore(self.root, '/fake/ffmpeg')
        other.processes_for_path = mock.Mock(side_effect=AssertionError('Live owner must not be scanned'))
        report = other.recover_stale_encoders()
        self.assertEqual(report['skippedActive'], 1)
        self.assertEqual(other.get(job['id'])['state'], 'active')

    def test_resume_reserves_transition_against_pause_discard_and_resume(self):
        job = self.store.create(request())
        entered, release = threading.Event(), threading.Event()
        original = self.store._resume_exclusive
        errors = []
        def delayed(*args):
            entered.set()
            release.wait(2)
            return original(*args)
        self.store._resume_exclusive = delayed
        def resume():
            try: self.store.resume(job['id'])
            except Exception as error: errors.append(error)
        worker = threading.Thread(target=resume)
        worker.start()
        self.assertTrue(entered.wait(2))
        try:
            for operation in (self.store.pause, self.store.discard, self.store.resume):
                with self.assertRaisesRegex(ValueError, 'stopping'):
                    operation(job['id'])
        finally:
            release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertIn(job['id'], self.store.owners)
        self.assertIn(job['id'], self.store.leases)
        self.assertNotIn(job['id'], self.store.stopping)

    def test_missing_encoder_allows_only_fully_verified_finalization(self):
        incomplete = self.store.create(request())
        with self.assertRaisesRegex(ValueError, 'libx264 unavailable'):
            self.store.resume(incomplete['id'], encoder_error='libx264 unavailable')
        self.assertNotIn(incomplete['id'], self.store.owners)
        self.assertNotIn(incomplete['id'], self.store.leases)
        complete = self.ready_job()
        result = self.store.resume(complete['id'], encoder_error='libx264 unavailable')
        self.assertEqual(result['nextFrame'], result['frames'])
        self.store.pause(complete['id'])
        # Repair can change a superficially complete job back to needing frames.
        (self.manifest(complete).parent / 'segment-000001.mkv').unlink()
        with self.assertRaisesRegex(ValueError, 'libx264 unavailable'):
            self.store.resume(complete['id'], encoder_error='libx264 unavailable')
        self.assertNotIn(complete['id'], self.store.owners)
        self.assertNotIn(complete['id'], self.store.leases)

    def test_resume_cannot_race_past_pause_transition(self):
        job = self.store.create(request())
        active = self.store.resume(job['id'])
        interrupted = threading.Event()
        release_pause = threading.Event()
        original_interrupt = self.store._interrupt_active_segment

        def delayed_interrupt(job_id):
            original_interrupt(job_id)
            if threading.current_thread().name == 'pausing-export':
                interrupted.set()
                release_pause.wait(2)

        self.store._interrupt_active_segment = delayed_interrupt
        pauser = threading.Thread(
            name='pausing-export',
            target=lambda: self.store.pause(job['id'], 'pause', active['lease']),
        )
        pauser.start()
        self.assertTrue(interrupted.wait(2))
        try:
            with self.assertRaisesRegex(ValueError, 'stopping'):
                self.store.resume(job['id'])
        finally:
            release_pause.set()
            pauser.join(2)
        self.assertFalse(pauser.is_alive())

    def test_poster_is_durable_provenance_and_discard_removes_it(self):
        job = self.store.create(request())
        active = self.store.resume(job['id'])
        png = b'\x89PNG\r\n\x1a\nposter'

        poster = self.store.write_poster(job['id'], png, active['lease'])

        poster_path = self.root / poster['url'].lstrip('/')
        self.assertEqual(poster_path.read_bytes(), png)
        persisted = json.loads(self.manifest(job).read_text())
        self.assertEqual(persisted['poster'], {
            'file': poster['filename'],
            'bytes': len(png),
            'sha256': hashlib.sha256(png).hexdigest(),
            'width': 1280,
            'height': 720,
        })
        self.store.discard(job['id'])
        self.assertFalse(poster_path.exists())

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
                self.command = command
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
        with mock.patch.dict('os.environ', {'TESSERACT_TEST_ENCODER_THREADS': '2'}):
            for frame in range(3):
                progress = self.store.write_frame(job['id'], frame, b'png', lease)
                self.assertEqual(progress['durableFrame'], 0)
        progress = self.store.write_frame(job['id'], 3, b'png', lease)
        self.assertEqual(progress['durableFrame'], 4)
        self.assertTrue(progress['checkpointed'])
        self.assertEqual(len(processes), 1)
        command = processes[0].command
        thread_flags = [index for index, arg in enumerate(command) if arg == '-threads']
        self.assertEqual(len(thread_flags), 2)
        self.assertLess(thread_flags[0], command.index('-i'), 'PNG decoder input scope')
        self.assertGreater(thread_flags[1], command.index('-c:v'), 'H.264 encoder output scope')
        self.assertEqual([command[index + 1] for index in thread_flags], ['2', '2'])
        self.assertEqual(command[command.index('-filter_threads') + 1], '1')
        color_filter = command[command.index('-vf') + 1]
        self.assertIn('scale=in_range=pc:out_range=tv:out_color_matrix=bt709', color_filter)
        self.assertIn('setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709', color_filter)
        for flag in ('-color_range', '-colorspace', '-color_primaries', '-color_trc'):
            self.assertEqual(command[command.index(flag) + 1], 'tv' if flag == '-color_range' else 'bt709')
        persisted = json.loads(self.manifest(job).read_text())
        self.assertEqual(persisted['nextFrame'], 4)
        self.assertEqual(persisted['segments'][0]['frames'], 4)
        self.assertEqual(persisted['segments'][0]['firstFrame'], 0)
        self.store.write_frame(job['id'], 4, b'png', lease)
        self.assertEqual(len(processes), 2)

    def test_zero_checkpoint_seconds_only_durably_saves_completed_export(self):
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
                self.output.write_bytes(b'complete-segment')
                self.returncode = 0
                return 0

            def kill(self):
                self.returncode = -9

        self.store.popen = FakeProcess
        job = self.store.create(request(fps=2, frames=3, checkpointSeconds=0))
        lease = self.store.resume(job['id'])['lease']

        for frame in range(2):
            progress = self.store.write_frame(job['id'], frame, b'png', lease)
            self.assertEqual(progress['durableFrame'], 0)
            self.assertFalse(progress['checkpointed'])
        progress = self.store.write_frame(job['id'], 2, b'png', lease)

        self.assertEqual(progress['durableFrame'], 3)
        self.assertTrue(progress['checkpointed'])
        self.assertEqual(len(processes), 1)

    def test_failed_stop_preserves_encoder_ownership_and_closes_stderr_copy(self):
        class ResistantProcess:
            pid = 23456
            def __init__(self, command, **kwargs):
                self.stdin = io.BytesIO()
                self.returncode = None
                self.fail_stop = True
                kwargs['stderr'].write(b'resistant encoder diagnostic')
                kwargs['stderr'].flush()
            def poll(self): return self.returncode
            def kill(self):
                if self.fail_stop: raise OSError('injected termination failure')
                self.returncode = -9
            def wait(self, timeout=None): return self.returncode
        self.store.popen = ResistantProcess
        job = self.store.create(request(frames=2))
        lease = self.store.resume(job['id'])['lease']
        self.store.write_frame(job['id'], 0, b'png', lease)
        runtime = self.store.active[job['id']]
        stream, log = runtime['stderrStream'], runtime['stderrPath']
        with self.assertRaisesRegex(ValueError, 'could not be stopped'):
            self.store.pause(job['id'], lease=lease)
        self.assertTrue(stream.closed)
        self.assertTrue(log.exists())
        self.assertIs(self.store.active[job['id']], runtime)
        self.assertIn('activeEncoder', json.loads(self.manifest(job).read_text()))
        # The frame-failure path must retain ownership and log as well.
        self.store._fail_active_segment(job['id'], runtime, 'injected frame failure')
        self.assertIs(self.store.active[job['id']], runtime)
        self.assertIn('activeEncoder', json.loads(self.manifest(job).read_text()))
        runtime['process'].fail_stop = False
        paused = self.store.pause(job['id'], lease=lease)
        self.assertEqual(paused['state'], 'paused')
        self.assertNotIn('could not be stopped', paused.get('reason') or '')
        self.assertIn('injected frame failure', paused['reason'])
        self.assertIn('resistant encoder diagnostic', paused['reason'])
        self.assertNotIn(job['id'], self.store.active)
        self.assertFalse(log.exists())

    def test_encoder_failure_pauses_at_last_durable_frame(self):
        class FailingProcess:
            def __init__(self, command, **kwargs):
                self.stdin = io.BytesIO()
                self.output = Path(command[-1])
                self.returncode = None
                kwargs['stderr'].write(b'libx264 test diagnostic')
                kwargs['stderr'].flush()

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
        self.assertIn('libx264 test diagnostic', persisted['error'])
        self.assertEqual(list(self.manifest(job).parent.glob('*.stderr.log')), [])

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

    def test_partial_resume_requires_matching_render_context(self):
        job = self.store.create(request())
        with self.assertRaisesRegex(ValueError, 'source URL and render settings'):
            self.store.resume(job['id'], {
                'sourceUrl': '/different',
                'renderSignature': 'render-v1',
            })
        self.assertNotIn(job['id'], self.store.leases)

        resumed = self.store.resume(job['id'], {
            'sourceUrl': '/?skybox=exports%2Ftest',
            'renderSignature': 'render-v1',
        })
        self.assertEqual(resumed['nextFrame'], 0)
        self.store.pause(job['id'], lease=resumed['lease'])

    def test_fully_rendered_resume_allows_finalize_from_changed_viewer(self):
        job = self.ready_job()

        resumed = self.store.resume(job['id'], {
            'sourceUrl': '/different',
            'renderSignature': 'different-render',
        })

        self.assertEqual(resumed['nextFrame'], resumed['frames'])
        self.store.pause(job['id'], lease=resumed['lease'])

    def test_finish_concats_segments_in_order_for_mp4_and_mkv(self):
        for video_format in ('mp4', 'mkv'):
            with self.subTest(video_format=video_format):
                root = self.root / video_format
                store = VideoJobStore(root, '/fake/ffmpeg')
                self.store = store
                job = self.ready_job(video_format)
                manifest = json.loads(self.manifest(job).read_text())
                manifest['request']['scratchPath'] = '/Volumes/private-render-scratch'
                self.write_manifest(job, manifest)
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
                self.assertNotIn('scratchPath', metadata)
                self.assertFalse(self.manifest(job).parent.exists())
                self.assertEqual(store.list_jobs(), [])

    def test_invalid_or_complete_frame_request_does_not_spawn_encoder(self):
        job=self.store.create(request())
        lease=self.store.resume(job['id'])['lease']
        with mock.patch.object(self.store,'popen') as spawn:
            with self.assertRaisesRegex(ValueError,'Expected frame 0'):
                self.store.write_frame(job['id'],1,b'png',lease)
            spawn.assert_not_called()
        self.store.pause(job['id'])
        ready=self.ready_job();active=self.store.resume(ready['id']);lease=active['lease']
        with mock.patch.object(self.store,'popen') as spawn:
            with self.assertRaisesRegex(ValueError,'already received all frames'):
                self.store.write_frame(ready['id'],active['nextFrame'],b'png',lease)
            spawn.assert_not_called()
        self.store.pause(ready['id'])

    def test_foreign_store_cannot_modify_owned_finalizer_files(self):
        job = self.ready_job()
        entered, release = threading.Event(), threading.Event()
        errors, pending = [], []
        def concat(command, **_kwargs):
            path = Path(command[-1]);path.write_bytes(b'in progress');pending.append(path)
            entered.set();release.wait(2)
            path.write_bytes(b'joined')
            return mock.Mock(returncode=0)
        self.store.run = concat
        def finish():
            try: self.store.finish(job['id'])
            except Exception as error: errors.append(error)
        worker = threading.Thread(target=finish);worker.start();self.assertTrue(entered.wait(2))
        foreign = VideoJobStore(self.root,'/fake/ffmpeg')
        try:
            for operation in (foreign.resume, foreign.finish, foreign.discard):
                with self.assertRaisesRegex(ValueError,'active in another server'):
                    operation(job['id'])
                self.assertTrue(pending[0].exists())
                self.assertTrue(self.manifest(job).exists())
        finally:
            release.set();worker.join(2)
        self.assertFalse(worker.is_alive());self.assertEqual(errors,[])
        self.assertEqual(foreign.owners,{})

    def test_second_resume_or_finish_cannot_cancel_or_unlock_a_finalizer(self):
        job = self.ready_job()
        entered, release = threading.Event(), threading.Event()
        errors = []
        def concat(command, **_kwargs):
            entered.set();release.wait(2)
            Path(command[-1]).write_bytes(b'joined')
            return mock.Mock(returncode=0)
        self.store.run = concat
        def finish():
            try: self.store.finish(job['id'])
            except Exception as error: errors.append(error)
        worker = threading.Thread(target=finish);worker.start()
        self.assertTrue(entered.wait(2))
        owner = self.store.owners[job['id']]
        try:
            for operation in (self.store.resume, self.store.finish):
                with self.assertRaisesRegex(ValueError, 'finalizing'):
                    operation(job['id'])
            self.assertIs(self.store.owners[job['id']], owner)
            self.assertFalse(owner.closed)
            self.assertNotIn(job['id'], self.store.stopping)
        finally:
            release.set();worker.join(2)
        self.assertFalse(worker.is_alive());self.assertEqual(errors, [])
        self.assertNotIn(job['id'], self.store.finishing)
        self.assertNotIn(job['id'], self.store.owners)

    def test_early_finalize_rejection_keeps_live_lease_but_failed_setup_releases_owner(self):
        incomplete = self.store.create(request())
        self.store.resume(incomplete['id'])
        with self.assertRaisesRegex(ValueError, 'durable frames'):
            self.store.finish(incomplete['id'])
        self.assertIn(incomplete['id'], self.store.leases)
        self.assertIn(incomplete['id'], self.store.owners)
        complete = self.ready_job()
        with mock.patch.object(self.store, '_save', side_effect=OSError('injected setup failure')):
            with self.assertRaisesRegex(OSError, 'setup failure'):
                self.store.finish(complete['id'])
        self.assertNotIn(complete['id'], self.store.owners)
        self.assertNotIn(complete['id'], self.store.finishing)

    def test_discard_wins_race_with_finalization_before_publish(self):
        job = self.ready_job('mp4')
        output = self.root / 'videos' / self.store.output_filename(job['id'])
        finalizer_started = threading.Event()
        discard_started = threading.Event()
        finish_errors = []
        discard_errors = []

        def run(command, **_kwargs):
            finalizer_started.set()
            discard_started.wait(2)
            Path(command[-1]).write_bytes(b'must not publish')
            return types.SimpleNamespace(returncode=0)

        self.store.run = run
        finisher = threading.Thread(
            target=lambda: self._capture_error(
                finish_errors, lambda: self.store.finish(job['id'])),
        )
        finisher.start()
        self.assertTrue(finalizer_started.wait(2))
        discarder = threading.Thread(
            target=lambda: (
                discard_started.set(),
                self._capture_error(discard_errors, lambda: self.store.discard(job['id'])),
            ),
        )
        discarder.start()
        finisher.join(2)
        discarder.join(2)

        self.assertFalse(finisher.is_alive())
        self.assertFalse(discarder.is_alive())
        self.assertEqual(len(finish_errors), 1)
        self.assertRegex(str(finish_errors[0]), 'cancel')
        self.assertEqual(discard_errors, [])
        self.assertFalse(output.exists())
        self.assertEqual(self.store.list_jobs(), [])

    def test_pause_preserves_more_specific_server_error(self):
        job = self.store.create(request())
        manifest = json.loads(self.manifest(job).read_text())
        manifest['error'] = 'ffmpeg exited while writing checkpoint 3'
        self.write_manifest(job, manifest)

        paused = self.store.pause(job['id'], 'Browser reported a network failure')

        self.assertEqual(paused['reason'], 'ffmpeg exited while writing checkpoint 3')

    def test_resume_clears_previous_pause_reason(self):
        job = self.store.create(request())
        self.store.pause(job['id'], 'Browser paused the export')

        resumed = self.store.resume(job['id'])

        self.assertIsNone(resumed['reason'])
        self.store.pause(job['id'], lease=resumed['lease'])

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

    def test_metadata_failure_rolls_back_published_video(self):
        job = self.ready_job('mp4')
        output = self.root / 'videos' / self.store.output_filename(job['id'])

        def run(command, **_kwargs):
            Path(command[-1]).write_bytes(b'complete')
            return types.SimpleNamespace(returncode=0)

        real_atomic_write = VideoJobStore.finish.__globals__['atomic_write_json']

        def fail_metadata(path, value):
            if path == output.with_suffix('.json'):
                raise OSError('metadata disk failure')
            return real_atomic_write(path, value)

        self.store.run = run
        with mock.patch('studio.video_resume.atomic_write_json', side_effect=fail_metadata):
            with self.assertRaisesRegex(ValueError, 'metadata disk failure'):
                self.store.finish(job['id'])

        self.assertFalse(output.exists())
        self.assertFalse(output.with_suffix('.json').exists())
        self.assertEqual(self.store.list_jobs()[0]['state'], 'ready')

    def test_index_failure_preserves_checkpoints_for_finalization_retry(self):
        job = self.ready_job('mp4')
        output = self.root / 'videos' / self.store.output_filename(job['id'])
        checkpoints = list(self.manifest(job).parent.glob('segment-*.mkv'))

        def run(command, **_kwargs):
            Path(command[-1]).write_bytes(b'complete')
            return types.SimpleNamespace(returncode=0)

        real_write_index = self.store._write_index

        def fail_completed_index(value):
            if job['id'] not in value['jobs']:
                raise OSError('index disk failure')
            return real_write_index(value)

        self.store.run = run
        self.store._write_index = fail_completed_index
        with self.assertRaisesRegex(ValueError, 'index disk failure'):
            self.store.finish(job['id'])

        self.assertFalse(output.exists())
        self.assertTrue(all(path.is_file() for path in checkpoints))
        self.assertEqual(self.store.list_jobs()[0]['state'], 'ready')


if __name__ == '__main__':
    unittest.main()
