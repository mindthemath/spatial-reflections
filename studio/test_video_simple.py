# Copyright 2026 Michael Pilosov. All rights reserved.
"""Mocked one-shot backend tests: no browser/network/real encoder."""
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

try:
    from video_simple import SimpleVideoBackend
except ImportError:
    from studio.video_simple import SimpleVideoBackend


class Encoder:
    def __init__(self, command, **kwargs):
        self.command = command
        self.output = Path(command[-1])
        self.stdin = io.BytesIO()
        self.returncode = None
    def poll(self): return self.returncode
    def kill(self): self.returncode = -9
    def wait(self, timeout=None):
        if self.returncode is None:
            self.output.write_bytes(b'movie')
            self.returncode = 0
        return self.returncode


def request(**overrides):
    return {'name':'simple','width':64,'height':64,'fps':24,'frames':2,
            'quality':'draft','format':'mp4','bitRate':100000,**overrides}


class SimpleVideoTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.backend = SimpleVideoBackend(self.root, '/fake/ffmpeg')
        self.backend.popen = Encoder
    def tearDown(self):
        self.backend.pause_all()
        self.backend.release_server()
        self.temp.cleanup()

    def test_one_process_no_checkpoint_store_and_atomic_publish(self):
        sentinel=self.root/'videos'/'.video-jobs.json'
        sentinel.parent.mkdir();sentinel.write_bytes(b'durable store must be untouched')
        saved_request=request(startFrame=17, viewerState={'shader':'chrome'},
                              renderSignature='verified-render', sourceUrl='/?skybox=exports/test')
        job=self.backend.start(saved_request)
        poster=b'png-with-embedded-view-settings'
        self.backend.write_poster(job['id'],poster,job['lease'])
        for frame in range(2):self.backend.write_frame(job['id'],frame,b'png',job['lease'])
        process=self.backend.jobs[job['id']]['process']
        self.assertEqual(process.stdin.getvalue(),b'pngpng')
        self.assertFalse(list((self.root/'videos').glob('*.mp4')))
        result=self.backend.finish(job['id'])
        output=self.root/result['url'].lstrip('/')
        self.assertEqual(output.read_bytes(),b'movie')
        self.assertEqual(output.with_suffix('.png').read_bytes(),poster)
        metadata=json.loads(output.with_suffix('.json').read_text())
        for key,value in saved_request.items():self.assertEqual(metadata[key],value)
        self.assertEqual(metadata['poster']['file'],output.with_suffix('.png').name)
        self.assertEqual(metadata['videoMode'],'simple');self.assertEqual(metadata['bytes'],5)
        self.assertNotIn('segments',metadata)
        self.assertEqual(sentinel.read_bytes(),b'durable store must be untouched')
        self.assertFalse((self.root/'videos'/'.checkpoints').exists())
        self.assertFalse(list((self.root/'videos').glob('.simple-*')))
        self.assertEqual(self.backend.jobs,{})
        self.assertNotIn('concat',process.command)
        self.assertIn('-xerror',process.command)
        self.assertIn('bt709',process.command)

    def test_cancel_discards_partial_and_pause_is_cancel(self):
        for action in ('discard','pause'):
            job=self.backend.start(request())
            self.backend.write_poster(job['id'],b'poster',job['lease'])
            self.backend.write_frame(job['id'],0,b'png',job['lease'])
            process=self.backend.jobs[job['id']]['process']
            getattr(self.backend,action)(job['id'])
            self.assertEqual(process.returncode,-9)
            self.assertEqual(self.backend.jobs,{})
            self.assertFalse(list((self.root/'videos').glob('.simple-*')))
            self.assertFalse(list((self.root/'videos').glob('*.png')))
            self.assertFalse(list((self.root/'videos').glob('*.json')))
        self.assertEqual(self.backend.list_jobs(),[])
        with self.assertRaisesRegex(ValueError,'no resume'):self.backend.resume('anything')

    def test_invalid_frame_or_lease_does_not_spawn(self):
        job=self.backend.start(request())
        with mock.patch.object(self.backend,'popen') as spawn:
            for frame,lease in ((1,job['lease']),(0,'wrong')):
                with self.assertRaises(ValueError):self.backend.write_frame(job['id'],frame,b'png',lease)
            spawn.assert_not_called()
        with self.assertRaises(ValueError):self.backend.finish(job['id'])
        self.assertIn(job['id'],self.backend.jobs)

    def test_encoder_failure_returns_diagnostic_and_discards(self):
        job=self.backend.start(request())
        self.backend.write_frame(job['id'],0,b'png',job['lease'])
        runtime=self.backend.jobs[job['id']]
        runtime['process'].returncode=1
        runtime['stderr'].write_text('libx264 diagnostic')
        with self.assertRaisesRegex(ValueError,'libx264 diagnostic'):
            self.backend.write_frame(job['id'],1,b'png',job['lease'])
        self.assertEqual(self.backend.jobs,{})

    def test_spawn_failure_and_finalize_failure_discard(self):
        job=self.backend.start(request())
        with mock.patch.object(self.backend,'popen',side_effect=OSError('spawn failed')):
            with self.assertRaisesRegex(ValueError,'spawn failed'):
                self.backend.write_frame(job['id'],0,b'png',job['lease'])
        self.assertEqual(self.backend.jobs,{})
        job=self.backend.start(request(frames=1))
        self.backend.write_frame(job['id'],0,b'png',job['lease'])
        self.backend.jobs[job['id']]['process'].returncode=1
        with self.assertRaisesRegex(ValueError,'restart from frame 0'):self.backend.finish(job['id'])
        self.assertEqual(self.backend.jobs,{})

    def test_existing_output_is_never_overwritten(self):
        job=self.backend.start(request(frames=1))
        destination=self.root/'videos'/job['filename'];destination.write_bytes(b'original')
        self.backend.write_frame(job['id'],0,b'png',job['lease'])
        with self.assertRaises(ValueError):self.backend.finish(job['id'])
        self.assertEqual(destination.read_bytes(),b'original')

    def test_existing_sidecar_is_not_overwritten_and_own_links_roll_back(self):
        for suffix in ('.png','.json','.mp4'):
            with self.subTest(suffix=suffix):
                job=self.backend.start(request(frames=1))
                self.backend.write_poster(job['id'],b'poster',job['lease'])
                destination=(self.root/'videos'/job['filename']).with_suffix(suffix)
                destination.write_bytes(b'original')
                self.backend.write_frame(job['id'],0,b'png',job['lease'])
                with self.assertRaises(ValueError):self.backend.finish(job['id'])
                self.assertEqual(destination.read_bytes(),b'original')
                for other in ('.png','.json','.mp4'):
                    if other!=suffix:self.assertFalse(destination.with_suffix(other).exists())
                destination.unlink()

    def test_poster_requires_current_lease_and_precedes_frames(self):
        job=self.backend.start(request())
        with self.assertRaises(ValueError):self.backend.write_poster(job['id'],b'poster','wrong')
        self.backend.write_frame(job['id'],0,b'png',job['lease'])
        with self.assertRaises(ValueError):self.backend.write_poster(job['id'],b'poster',job['lease'])

    def test_one_active_export_and_shared_project_lock(self):
        job=self.backend.start(request())
        with self.assertRaisesRegex(ValueError,'one export'):self.backend.start(request())
        foreign=SimpleVideoBackend(self.root,'/fake/ffmpeg')
        with self.assertRaisesRegex(ValueError,'Another video server'):foreign.claim_server()
        self.backend.discard(job['id'])

    def test_cancel_wakes_blocked_writer_before_waiting_for_job_lock(self):
        entered,release=threading.Event(),threading.Event()
        class Pipe:
            closed=False
            def write(self,data):entered.set();release.wait(3);raise BrokenPipeError('cancelled')
            def flush(self):pass
            def close(self):self.closed=True
        class BlockingEncoder(Encoder):
            def __init__(self,*args,**kwargs):super().__init__(*args,**kwargs);self.stdin=Pipe()
            def kill(self):super().kill();release.set()
        self.backend.popen=BlockingEncoder
        job=self.backend.start(request());errors=[]
        def write():
            try:self.backend.write_frame(job['id'],0,b'png',job['lease'])
            except ValueError as error:errors.append(error)
        worker=threading.Thread(target=write);worker.start()
        try:
            self.assertTrue(entered.wait(2));self.backend.discard(job['id']);worker.join(2)
        finally:release.set();worker.join(2)
        self.assertFalse(worker.is_alive());self.assertEqual(len(errors),1)
        self.assertEqual(self.backend.jobs,{})

    def test_failed_kill_retains_runtime_until_retry(self):
        job=self.backend.start(request())
        self.backend.write_frame(job['id'],0,b'png',job['lease'])
        process=self.backend.jobs[job['id']]['process']
        with mock.patch.object(process,'kill',side_effect=OSError('unstoppable')):
            with self.assertRaisesRegex(ValueError,'could not be stopped'):self.backend.discard(job['id'])
        self.assertIn(job['id'],self.backend.jobs)
        self.backend.discard(job['id'])

    def test_idle_candidates_recheck_heartbeat_and_finalization(self):
        job=self.backend.start(request())
        runtime=self.backend.jobs[job['id']]
        cutoff=runtime['lastActivity']
        runtime['lastActivity']=cutoff+1
        self.backend.discard(job['id'],_idle_before=cutoff)
        self.assertIn(job['id'],self.backend.jobs)
        runtime['lastActivity']=cutoff-1000;runtime['state']='finalizing'
        self.backend.discard(job['id'],_idle_before=cutoff)
        self.assertIn(job['id'],self.backend.jobs)
        self.backend.discard(job['id'])

    def test_published_movie_stays_successful_if_temp_cleanup_fails(self):
        job=self.backend.start(request(frames=1))
        self.backend.write_frame(job['id'],0,b'png',job['lease'])
        with mock.patch('shutil.rmtree',side_effect=OSError('cleanup failed')):
            result=self.backend.finish(job['id'])
        self.assertEqual((self.root/result['url'].lstrip('/')).read_bytes(),b'movie')
        self.assertEqual(self.backend.jobs,{})

    def test_cancel_during_finish_never_publishes(self):
        entered,release=threading.Event(),threading.Event()
        class SlowEncoder(Encoder):
            def wait(self,timeout=None):entered.set();release.wait(3);return super().wait(timeout)
            def kill(self):super().kill();release.set()
        self.backend.popen=SlowEncoder
        job=self.backend.start(request(frames=1));self.backend.write_frame(job['id'],0,b'png',job['lease'])
        errors=[]
        def finish():
            try:self.backend.finish(job['id'])
            except ValueError as error:errors.append(error)
        worker=threading.Thread(target=finish);worker.start()
        try:
            self.assertTrue(entered.wait(2));self.backend.discard(job['id']);worker.join(2)
        finally:release.set();worker.join(2)
        self.assertFalse(worker.is_alive());self.assertEqual(len(errors),1)
        self.assertFalse(list((self.root/'videos').glob('*.mp4')))
