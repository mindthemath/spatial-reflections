# Copyright 2026 Michael Pilosov. All rights reserved.
import base64
import hashlib
import io
import json
import socket
import threading
import unittest
from unittest import mock
from pathlib import Path

import server

# A minimal 1x1 PNG, sufficient for the API's signature validation.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=')


from server_test_fixture import ServerAPITestCase


class VideoAPITest(ServerAPITestCase):
    def test_simple_mode_is_one_shot_and_never_constructs_resume_store(self):
        class Encoder:
            def __init__(self,command,**_kwargs):self.stdin=io.BytesIO();self.output=Path(command[-1]);self.returncode=None
            def poll(self):return self.returncode
            def kill(self):self.returncode=-9
            def wait(self,timeout=None):
                if self.returncode is None:self.output.write_bytes(b'movie');self.returncode=0
                return self.returncode
        with mock.patch.object(server,'VIDEO_MODE','simple'), \
             mock.patch.object(server.shutil,'which',return_value='/fake/ffmpeg'), \
             mock.patch.object(server.subprocess,'Popen',Encoder), \
             mock.patch.object(server,'ffmpeg_encoder_error',return_value=None), \
             mock.patch.object(server,'VideoJobStore',side_effect=AssertionError('Resume backend must not be used')):
            code,caps=self.request('GET','/api/video/capabilities')
            self.assertEqual(code,200);self.assertEqual(caps['videoMode'],'simple');self.assertFalse(caps['resumable'])
            code,job=self.request('POST','/api/video/start',{'name':'one-shot','width':64,'height':64,'fps':24,'frames':1,'scratchPath':'/not/a/directory','checkpointSeconds':99999})
            self.assertEqual(code,201)
            frame=server.PNG_SIGNATURE+(13).to_bytes(4,'big')+b'IHDR'+(64).to_bytes(4,'big')+(64).to_bytes(4,'big')
            code,_=self.raw_request('POST',f"/api/video/poster?id={job['id']}&lease={job['lease']}",frame,{'Content-Type':'image/png'})
            self.assertEqual(code,201)
            code,_=self.raw_request('POST',f"/api/video/frame?id={job['id']}&frame=0&lease={job['lease']}",frame,{'Content-Type':'image/png'})
            self.assertEqual(code,201)
            code,result=self.request('POST','/api/video/finish',{'id':job['id']})
            self.assertEqual(code,201);self.assertEqual((server.ROOT/result['url'].lstrip('/')).read_bytes(),b'movie')
            output=server.ROOT/result['url'].lstrip('/')
            self.assertEqual(output.with_suffix('.png').read_bytes(),frame)
            metadata=json.loads(output.with_suffix('.json').read_text())
            self.assertEqual(metadata['file'],output.name);self.assertEqual(metadata['videoMode'],'simple')
            code,value=self.request('GET','/api/video/jobs');self.assertEqual(code,200);self.assertEqual(value['jobs'],[])
            code,error=self.request('POST','/api/video/resume',{'id':job['id']})
            self.assertEqual(code,400);self.assertIn('no resume',error['error'])
            self.assertFalse((server.ROOT/'videos'/'.checkpoints').exists())
            self.assertFalse((server.ROOT/'videos'/'.video-jobs.json').exists())
            server.VIDEO_STORE.release_server()


    def test_streamed_video_export(self):
        class FakeFFmpeg:
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.output = Path(command[-1])
                self.returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                self.output.write_bytes(b'fake mp4')
                self.returncode = 0
                return 0

            def kill(self):
                self.returncode = -9

        request = {'name': '../mirror clip', 'width': 64, 'height': 64, 'fps': 24,
                   'frames': 2, 'quality': 'standard', 'viewerState': {'shader': 'chrome'}}
        def fake_run(command, **_kwargs):
            Path(command[-1]).write_bytes(b'fake mp4')
            return mock.Mock(returncode=0)

        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'), \
             mock.patch.object(server.subprocess, 'Popen', FakeFFmpeg), \
             mock.patch.object(server.subprocess, 'run', fake_run):
            code, started = self.request('POST', '/api/video/start', request)
            self.assertEqual(code, 201)
            frame = server.PNG_SIGNATURE + (13).to_bytes(4, 'big') + b'IHDR' + (64).to_bytes(4, 'big') + (64).to_bytes(4, 'big')
            code, poster = self.raw_request(
                'POST', f"/api/video/poster?id={started['id']}&lease={started['lease']}", frame,
                {'Content-Type': 'image/png'})
            self.assertEqual(code, 201)
            self.assertEqual(poster['filename'], started['filename'].rsplit('.', 1)[0] + '.png')
            for index in range(2):
                code, progress = self.raw_request('POST', f"/api/video/frame?id={started['id']}&frame={index}&lease={started['lease']}", frame,
                                                  {'Content-Type': 'image/png'})
                self.assertEqual(code, 201)
                self.assertEqual(progress['frame'], index + 1)
            self.request('POST', '/api/video/pause', {'id': started['id'], 'lease': started['lease']})
            with mock.patch.object(server, 'FFMPEG_ENCODER_ERROR', 'libx264 unavailable'):
                code, capabilities = self.request('GET', '/api/video/capabilities')
                self.assertFalse(capabilities['available'])
                self.assertTrue(capabilities['canManage'])
                code, resumed = self.request('POST', '/api/video/resume', {'id': started['id']})
                self.assertEqual(code, 200)
                self.assertEqual(resumed['nextFrame'], 2)
                code, completed = self.request('POST', '/api/video/finish', {'id': started['id']})
                self.assertEqual(code, 201)
        video = server.ROOT / completed['url'].lstrip('/')
        self.assertEqual(video.read_bytes(), b'fake mp4')
        self.assertTrue((video.with_suffix('.png')).is_file())
        metadata = json.loads(video.with_suffix('.json').read_text())
        self.assertEqual(metadata['frames'], 2)
        self.assertEqual(metadata['viewerState']['shader'], 'chrome')
        self.assertEqual(metadata['poster']['file'], video.with_suffix('.png').name)
        self.assertEqual(metadata['poster']['sha256'], hashlib.sha256(frame).hexdigest())
        self.assertNotIn('..', completed['filename'])
        self.assertIn('mirror-clip', server.video_clip_labels())


    def test_mkv_video_export_uses_matroska_container(self):
        commands = []

        class FakeFFmpeg:
            def __init__(self, command, **_kwargs):
                commands.append(command)
                self.stdin = io.BytesIO()
                self.output = Path(command[-1])
                self.returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                self.output.write_bytes(b'fake mkv')
                self.returncode = 0
                return 0

            def kill(self):
                self.returncode = -9

        request = {'name': 'matroska clip', 'width': 64, 'height': 64, 'fps': 24,
                   'frames': 1, 'quality': 'standard', 'format': 'mkv'}
        frame = server.PNG_SIGNATURE + (13).to_bytes(4, 'big') + b'IHDR' + (64).to_bytes(4, 'big') + (64).to_bytes(4, 'big')
        def fake_run(command, **_kwargs):
            Path(command[-1]).write_bytes(b'fake mkv')
            return mock.Mock(returncode=0)

        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'), \
             mock.patch.object(server.subprocess, 'Popen', FakeFFmpeg), \
             mock.patch.object(server.subprocess, 'run', fake_run):
            code, started = self.request('POST', '/api/video/start', request)
            self.assertEqual(code, 201)
            self.assertTrue(started['filename'].endswith('.mkv'))
            self.assertEqual(self.raw_request(
                'POST', f"/api/video/frame?id={started['id']}&frame=0&lease={started['lease']}", frame,
                {'Content-Type': 'image/png'})[0], 201)
            self.assertNotIn('-movflags', commands[0])
            self.assertEqual(commands[0][-3:-1], ['-f', 'matroska'])
            self.assertTrue(str(commands[0][-1]).endswith('.pending.mkv'))
            code, completed = self.request('POST', '/api/video/finish', {'id': started['id']})
            self.assertEqual(code, 201)
        self.assertTrue(completed['filename'].endswith('.mkv'))
        metadata = json.loads((server.ROOT / completed['url'].lstrip('/')).with_suffix('.json').read_text())
        self.assertEqual(metadata['format'], 'mkv')
        self.assertIn('matroska-clip', server.video_clip_labels())


    def test_resumable_video_api_survives_store_recreation(self):
        class FakeFFmpeg:
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.output = Path(command[-1])
                self.returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                self.output.write_bytes(b'checkpoint')
                self.returncode = 0
                return 0

            def kill(self):
                self.returncode = -9

        def fake_run(command, **_kwargs):
            Path(command[-1]).write_bytes(b'final video')
            return mock.Mock(returncode=0)

        request = {
            'name': 'overnight', 'width': 64, 'height': 64, 'fps': 24,
            'frames': 25, 'quality': 'draft', 'format': 'mkv',
            'checkpointSeconds': 1, 'sourceUrl': '/?skybox=exports%2Ftest',
            'renderSignature': 'same-render',
        }
        frame = server.PNG_SIGNATURE + (13).to_bytes(4, 'big') + b'IHDR' + (64).to_bytes(4, 'big') + (64).to_bytes(4, 'big')
        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'), \
             mock.patch.object(server.subprocess, 'Popen', FakeFFmpeg), \
             mock.patch.object(server.subprocess, 'run', fake_run):
            code, started = self.request('POST', '/api/video/start', request)
            self.assertEqual(code, 201)
            self.assertIn('lease', started)
            for index in range(24):
                code, progress = self.raw_request(
                    'POST',
                    f"/api/video/frame?id={started['id']}&frame={index}&lease={started['lease']}",
                    frame, {'Content-Type': 'image/png'})
                self.assertEqual(code, 201)
            self.assertEqual(progress['durableFrame'], 24)
            self.assertEqual(self.request('POST', '/api/video/pause', {
                'id': started['id'], 'lease': started['lease']})[0], 200)

            server.VIDEO_STORE = None
            code, jobs = self.request('GET', '/api/video/jobs')
            self.assertEqual(code, 200)
            self.assertEqual(jobs['jobs'][0]['nextFrame'], 24)
            code, mismatch = self.request('POST', '/api/video/resume', {
                'id': started['id'], 'sourceUrl': '/different',
                'renderSignature': 'same-render',
            })
            self.assertEqual(code, 400)
            self.assertIn('render settings', mismatch['error'])
            code, resumed = self.request('POST', '/api/video/resume', {
                'id': started['id'], 'sourceUrl': request['sourceUrl'],
                'renderSignature': request['renderSignature'],
            })
            self.assertEqual(code, 200)
            self.assertNotEqual(resumed['lease'], started['lease'])
            code, progress = self.raw_request(
                'POST',
                f"/api/video/frame?id={started['id']}&frame=24&lease={resumed['lease']}",
                frame, {'Content-Type': 'image/png'})
            self.assertEqual(code, 201)
            self.assertEqual(progress['durableFrame'], 25)
            code, completed = self.request('POST', '/api/video/finish', {'id': started['id']})
            self.assertEqual(code, 201)
            self.assertTrue(completed['filename'].endswith('.mkv'))
            self.assertTrue((server.ROOT / completed['url'].lstrip('/')).is_file())
            self.assertEqual(self.request('GET', '/api/video/jobs')[1]['jobs'], [])


    def test_video_cancel_discards_resumable_job(self):
        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'):
            code, started = self.request('POST', '/api/video/start', {
                'name': 'discard', 'width': 64, 'height': 64, 'fps': 24,
                'frames': 24, 'quality': 'draft', 'format': 'mp4',
                'checkpointSeconds': 60,
            })
            self.assertEqual(code, 201)
            self.assertEqual(self.request('POST', '/api/video/cancel', {'id': started['id']})[0], 200)
            self.assertEqual(self.request('GET', '/api/video/jobs')[1]['jobs'], [])
            code, result = self.request('POST', '/api/video/start', {
                'name': 'bad-scratch', 'width': 64, 'height': 64, 'fps': 24,
                'frames': 24, 'quality': 'draft', 'format': 'mp4',
                'checkpointSeconds': 60, 'scratchPath': ['not', 'a', 'path'],
            })
            self.assertEqual(code, 400)
            self.assertIn('scratch', result['error'].lower())


    def test_stalled_video_frame_upload_unblocks(self):
        class FakeFFmpeg:
            def __init__(self, command, **_kwargs):
                self.stdin = io.BytesIO()
                self.returncode = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                self.returncode = 0
                return 0

            def kill(self):
                self.returncode = -9

        previous = server.VIDEO_FRAME_READ_TIMEOUT
        server.VIDEO_FRAME_READ_TIMEOUT = 0.3
        started = None
        try:
            with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'), \
                 mock.patch.object(server.subprocess, 'Popen', FakeFFmpeg):
                code, started = self.request('POST', '/api/video/start', {
                    'name': 'stall', 'width': 64, 'height': 64, 'fps': 24, 'frames': 2, 'quality': 'draft'})
            self.assertEqual(code, 201)
            sock = socket.create_connection(('localhost', self.http.server_port))
            sock.settimeout(2)
            header = server.PNG_SIGNATURE + (13).to_bytes(4, 'big') + b'IHDR' + (64).to_bytes(4, 'big') + (64).to_bytes(4, 'big')
            request = (
                f"POST /api/video/frame?id={started['id']}&frame=0 HTTP/1.1\r\n"
                f"Host: localhost\r\nContent-Length: 5000000\r\nConnection: close\r\n\r\n"
            ).encode() + header
            sock.sendall(request)
            chunks = []
            while True:
                part = sock.recv(4096)
                if not part:
                    break
                chunks.append(part)
                response = b''.join(chunks)
                if b'\r\n\r\n' in response and len(response.split(b'\r\n\r\n', 1)[1]) >= 41:
                    break
            sock.close()
            response = b''.join(chunks)
            self.assertIn(b'400', response.split(b'\r\n', 1)[0])
            self.assertTrue(b'interrupted' in response or b'Incomplete' in response)
            code, _ = self.request('GET', '/api/video/capabilities')
            self.assertEqual(code, 200)
        finally:
            server.VIDEO_FRAME_READ_TIMEOUT = previous
            if started:
                self.request('POST', '/api/video/cancel', {'id': started['id']})


    def test_video_validation_and_capabilities(self):
        with mock.patch.object(server.shutil, 'which', return_value=None):
            code, capabilities = self.request('GET', '/api/video/capabilities')
            self.assertEqual(code, 200)
            self.assertFalse(capabilities['available'])
            self.assertEqual(capabilities['formats'], ['mp4', 'mkv'])
            self.assertFalse(capabilities['encoderRecovery']['indexFailed'])
            code, result = self.request('POST', '/api/video/start', {
                'width': 1920, 'height': 1080, 'fps': 60, 'frames': 60, 'quality': 'standard'})
            self.assertEqual(code, 400)
            self.assertIn('ffmpeg', result['error'])
        with self.assertRaises(ValueError):
            server.validate_video_request({'width': 1919, 'height': 1080, 'fps': 60, 'frames': 60, 'quality': 'standard'})
        with self.assertRaisesRegex(ValueError, 'format'):
            server.validate_video_request({
                'width': 1920, 'height': 1080, 'fps': 60, 'frames': 60,
                'quality': 'standard', 'format': 'avi'})
        master = server.validate_video_request({
            'width': 1920, 'height': 1080, 'fps': 30, 'frames': 900,
            'quality': 'master', 'format': 'mp4'})
        self.assertEqual(master[4], 'master')
        self.assertEqual(master[6], round(1920 * 1080 * 30 * .8))
        capped = server.validate_video_request({
            'width': 1920, 'height': 1080, 'fps': 30, 'frames': 900,
            'quality': 'capped', 'format': 'mp4'})
        self.assertEqual(capped[4], 'capped')
        self.assertEqual(capped[6], round(1920 * 1080 * 30 * .8))


    def test_ffmpeg_preflight_requires_libx264(self):
        supported = mock.Mock(returncode=0, stdout=' V....D libx264 H.264 encoder')
        missing = mock.Mock(returncode=0, stdout=' V....D h264_videotoolbox H.264 encoder')
        with mock.patch.object(server.subprocess, 'run', return_value=supported):
            self.assertIsNone(server.ffmpeg_encoder_error('/fake/ffmpeg'))
        with mock.patch.object(server.subprocess, 'run', return_value=missing):
            self.assertIn('libx264', server.ffmpeg_encoder_error('/fake/ffmpeg'))
        previous = server.FFMPEG_ENCODER_ERROR
        server.FFMPEG_ENCODER_ERROR = 'ffmpeg does not provide the required libx264 H.264 encoder'
        try:
            with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'):
                code, capabilities = self.request('GET', '/api/video/capabilities')
                self.assertEqual(code, 200)
                self.assertFalse(capabilities['available'])
                self.assertTrue(capabilities['canManage'])
                self.assertIn('libx264', capabilities['reason'])
                code, rejected = self.raw_request('POST', '/api/video/frame', PNG, {'Content-Type': 'image/png'})
                self.assertEqual(code, 400)
                self.assertIn('libx264', rejected['error'])
                self.assertIsNone(self.connection.sock, 'Rejected unread frame body must close the connection')
        finally:
            server.FFMPEG_ENCODER_ERROR = previous


    def test_background_recovery_keeps_live_upload_and_pause_usable(self):
        entered, release = threading.Event(), threading.Event()
        class FakeEncoder:
            def __init__(self,command,**_kwargs):
                self.stdin=io.BytesIO();self.output=Path(command[-1]);self.returncode=None
            def poll(self): return self.returncode
            def wait(self,timeout=None):
                self.output.write_bytes(b'checkpoint');self.returncode=0;return 0
            def kill(self): self.returncode=-9
        with mock.patch.object(server.shutil,'which',return_value='/fake/ffmpeg'), \
             mock.patch.object(server.subprocess,'Popen',FakeEncoder):
            code,started=self.request('POST','/api/video/start',{'width':64,'height':64,'fps':24,'frames':1,'quality':'draft'})
            self.assertEqual(code,201);store=server.video_store()
            code,cancelled=self.request('POST','/api/video/start',{'width':64,'height':64,'fps':24,'frames':1,'quality':'draft'})
            self.assertEqual(code,201)
            def scan():
                entered.set();release.wait(3)
                return store._empty_recovery_report()
            with mock.patch.object(store,'_recover_stale_encoders',side_effect=scan):
                worker=threading.Thread(target=store.recover_stale_encoders);worker.start()
                self.assertTrue(entered.wait(2))
                try:
                    frame=server.PNG_SIGNATURE+(13).to_bytes(4,'big')+b'IHDR'+(64).to_bytes(4,'big')+(64).to_bytes(4,'big')
                    code,_=self.raw_request('POST',f"/api/video/frame?id={started['id']}&frame=0&lease={started['lease']}",frame,{'Content-Type':'image/png'})
                    self.assertEqual(code,201)
                    code,_=self.request('POST','/api/video/pause',{'id':started['id'],'lease':started['lease']})
                    self.assertEqual(code,200)
                    code,_=self.request('POST','/api/video/cancel',{'id':cancelled['id'],'lease':cancelled['lease']})
                    self.assertEqual(code,200)
                    code,error=self.request('POST','/api/video/resume',{'id':started['id']})
                    self.assertEqual(code,400);self.assertIn('recovery is still running',error['error'])
                finally:
                    release.set();worker.join(2)
                self.assertFalse(worker.is_alive())


    def test_encoder_install_after_cli_startup_requires_restart(self):
        with mock.patch.object(server,'VIDEO_FFMPEG_BOOTSTRAP',''), \
             mock.patch.object(server.shutil,'which',return_value='/new/ffmpeg'), \
             mock.patch.object(server,'VideoJobStore') as factory:
            code,value=self.request('GET','/api/video/capabilities')
            self.assertEqual(code,200);self.assertFalse(value['available']);self.assertFalse(value['canManage'])
            self.assertIn('Restart the Studio server',value['reason'])
            code,error=self.request('POST','/api/video/start',{'width':64,'height':64,'fps':24,'frames':1})
            self.assertEqual(code,400);self.assertIn('Restart the Studio server',error['error'])
            code,error=self.request('GET','/api/video/jobs')
            self.assertEqual(code,400);self.assertIn('Restart the Studio server',error['error'])
            factory.assert_not_called()


    def test_existing_jobs_can_be_paused_or_cancelled_after_encoder_path_changes(self):
        with mock.patch.object(server.shutil,'which',return_value='/fake/ffmpeg'):
            jobs=[]
            for _ in range(2):
                code,job=self.request('POST','/api/video/start',{'width':64,'height':64,'fps':24,'frames':1})
                self.assertEqual(code,201);jobs.append(job)
        with mock.patch.object(server,'VIDEO_FFMPEG_BOOTSTRAP','/fake/ffmpeg'), \
             mock.patch.object(server.shutil,'which',return_value='/new/ffmpeg'), \
             mock.patch.object(server,'VideoJobStore') as factory:
            code,value=self.request('GET','/api/video/capabilities')
            self.assertEqual(code,200);self.assertFalse(value['available'])
            code,value=self.request('GET','/api/video/jobs')
            self.assertEqual(code,200);self.assertEqual(len(value['jobs']),2)
            code,_=self.request('POST','/api/video/pause',{'id':jobs[0]['id'],'lease':jobs[0]['lease']})
            self.assertEqual(code,200)
            code,_=self.request('POST','/api/video/cancel',{'id':jobs[1]['id'],'lease':jobs[1]['lease']})
            self.assertEqual(code,200);factory.assert_not_called()


    def test_video_mutations_wait_for_startup_recovery(self):
        with mock.patch.object(server.shutil,'which',return_value='/fake/ffmpeg'):
            store = server.video_store();store.recovery_running = True
            try:
                for route in ('start','resume','pause','cancel','finish'):
                    code, error = self.request('POST',f'/api/video/{route}',{'id':'0'*32})
                    self.assertEqual(code,400);self.assertIn('recovery is still running',error['error'])
                    self.assertIsNone(self.connection.sock)
                code,error = self.raw_request('POST','/api/video/frame',PNG,{'Content-Type':'image/png'})
                self.assertEqual(code,400);self.assertIn('recovery is still running',error['error'])
            finally:
                store.recovery_running = False
            store.last_recovery['indexFailed'] = True
            code,error = self.request('POST','/api/video/resume',{'id':'0'*32})
            self.assertEqual(code,400);self.assertIn('durable job index',error['error'])


    def test_preflight_repairs_pid_metadata_after_failed_live_pause(self):
        class Encoder:
            pid=23456
            def __init__(self,*_args,**_kwargs): self.stdin=io.BytesIO();self.returncode=None
            def poll(self): return self.returncode
            def kill(self): self.returncode=-9
            def wait(self,timeout=None): return self.returncode
        with mock.patch.object(server.shutil,'which',return_value='/fake/ffmpeg'), \
             mock.patch.object(server.subprocess,'Popen',Encoder):
            code,started=self.request('POST','/api/video/start',{'width':64,'height':64,'fps':24,'frames':2,'quality':'draft','sourceUrl':'/','renderSignature':'render-v1'})
            self.assertEqual(code,201)
            frame=server.PNG_SIGNATURE+(13).to_bytes(4,'big')+b'IHDR'+(64).to_bytes(4,'big')+(64).to_bytes(4,'big')
            code,_=self.raw_request('POST',f"/api/video/frame?id={started['id']}&frame=0&lease={started['lease']}",frame,{'Content-Type':'image/png'})
            self.assertEqual(code,201);store=server.video_store()
            store.processes_for_path=lambda _path: [];store.process_command=lambda _pid: ''
            with mock.patch.object(store,'_save',side_effect=OSError('scratch unplugged')):
                code,_=self.request('POST','/api/video/pause',{'id':started['id'],'lease':started['lease']})
                self.assertEqual(code,500)
            self.assertTrue(store.recovery_pending)
            code,capabilities=self.request('GET','/api/video/capabilities')
            self.assertEqual(code,200);self.assertTrue(capabilities['available'])
            self.assertEqual(store.get(started['id'])['state'],'paused')
            code,resumed=self.request('POST','/api/video/resume',{'id':started['id'],'sourceUrl':'/','renderSignature':'render-v1'})
            self.assertEqual(code,200);self.assertTrue(resumed['lease'])


    def test_preflight_repairs_active_metadata_after_failed_idle_pause(self):
        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'):
            code, started = self.request('POST', '/api/video/start', {
                'width':64,'height':64,'fps':24,'frames':1,'quality':'draft'})
            self.assertEqual(code,201)
            store = server.video_store()
            store.processes_for_path = lambda _path: []
            with mock.patch.object(store, '_save', side_effect=OSError('unmounted scratch')):
                code, _ = self.request('POST','/api/video/pause',{'id':started['id'],'lease':started['lease']})
                self.assertEqual(code,500)
            self.assertTrue(store.recovery_pending)
            self.assertNotIn(started['id'],store.owners)
            code, capabilities = self.request('GET','/api/video/capabilities')
            self.assertEqual(code,200);self.assertTrue(capabilities['available'])
            self.assertFalse(store.recovery_pending)
            self.assertEqual(store.get(started['id'])['state'],'paused')


    def test_video_pause_accepts_bounded_failure_reason(self):
        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'):
            code, started = self.request('POST', '/api/video/start', {
                'width': 1280, 'height': 720, 'fps': 30, 'frames': 30,
                'quality': 'standard',
            })
            self.assertEqual(code, 201)
            code, paused = self.request('POST', '/api/video/pause', {
                'id': started['id'], 'lease': started['lease'],
                'reason': '  WebGL context\nwas lost  ',
            })
            self.assertEqual(code, 200)
            self.assertEqual(paused['reason'], 'WebGL context was lost')

            code, rejected = self.request('POST', '/api/video/pause', {
                'id': started['id'], 'reason': 'x' * 501,
            })
            self.assertEqual(code, 400)
            self.assertIn('reason', rejected['error'].lower())


    def test_video_store_is_initialized_once_across_threads(self):
        created = []
        hold_constructor = threading.Event()

        class FakeStore:
            def __init__(self, root, ffmpeg):
                created.append(self)
                hold_constructor.wait(0.05)
                self.root = root
                self.ffmpeg = str(ffmpeg)

            def pause_all(self):
                pass

        stores = []
        server.VIDEO_STORE = None
        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'), \
             mock.patch.object(server, 'VideoJobStore', FakeStore):
            threads = [threading.Thread(target=lambda: stores.append(server.video_store()))
                       for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(2)

        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(len(created), 1)
        self.assertEqual(len({id(store) for store in stores}), 1)


    def test_video_capabilities_reports_startup_encoder_recovery(self):
        fake_store = mock.Mock()
        fake_store.last_recovery = {
            'recovered': 2, 'alreadyExited': 3, 'refused': 1,
            'skippedActive': 0, 'failed': 0, 'indexFailed': False,
        }
        fake_store.recovery_running = False
        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'), \
             mock.patch.object(server, 'video_store', return_value=fake_store):
            code, capabilities = self.request('GET', '/api/video/capabilities')
        self.assertEqual(code, 200)
        self.assertEqual(capabilities['encoderRecovery'], {
            'recovered': 2, 'alreadyExited': 3, 'refused': 1,
            'skippedActive': 0, 'failed': 0, 'indexFailed': False,
        })


    def test_video_capabilities_waits_for_startup_recovery(self):
        fake_store = mock.Mock()
        fake_store.last_recovery = {
            'recovered': 0, 'alreadyExited': 0, 'refused': 0,
            'skippedActive': 0, 'failed': 0, 'indexFailed': False,
        }
        fake_store.recovery_running = True
        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'), \
             mock.patch.object(server, 'video_store', return_value=fake_store):
            code, capabilities = self.request('GET', '/api/video/capabilities')
        self.assertEqual(code, 200)
        self.assertFalse(capabilities['available'])
        self.assertIn('recovery', capabilities['reason'].lower())


    def test_per_job_recovery_warning_does_not_disable_new_exports(self):
        fake_store = mock.Mock()
        fake_store.last_recovery = {
            'recovered': 0, 'alreadyExited': 0, 'refused': 0,
            'skippedActive': 0, 'failed': 1, 'indexFailed': False,
        }
        fake_store.recovery_running = False
        with mock.patch.object(server.shutil, 'which', return_value='/fake/ffmpeg'), \
             mock.patch.object(server, 'video_store', return_value=fake_store):
            code, capabilities = self.request('GET', '/api/video/capabilities')
        self.assertEqual(code, 200)
        self.assertTrue(capabilities['available'])


class ServerStartupTest(unittest.TestCase):
    def test_cli_refuses_lazy_store_after_encoder_install_or_path_change(self):
        old=mock.Mock()
        for bootstrap in ('','/old/ffmpeg'):
            with self.subTest(bootstrap=bootstrap), \
                 mock.patch.object(server,'VIDEO_FFMPEG_BOOTSTRAP',bootstrap), \
                 mock.patch.object(server,'VIDEO_STORE',old), \
                 mock.patch.object(server.shutil,'which',return_value='/new/ffmpeg'), \
                 mock.patch.object(server,'VideoJobStore') as factory:
                with self.assertRaisesRegex(ValueError,'Restart the Studio server'):
                    server.video_store()
                factory.assert_not_called();old.pause_all.assert_not_called()
                old.release_server.assert_not_called()

    def test_recovery_gate_allows_only_a_known_live_owner_lease(self):
        store=mock.Mock(recovery_running=True,lock=threading.RLock(),leases={},owners={},last_recovery={'indexFailed':False})
        with self.assertRaisesRegex(ValueError,'recovery is still running'):
            server.check_video_recovery(store,'job','old-nonce')
        store.leases['job']={'token':'nonce'};store.owners['job']=mock.Mock()
        server.check_video_recovery(store,'job','nonce')
        with self.assertRaises(ValueError): server.check_video_recovery(store,'job','old-nonce')
        store.recovery_running=False;store.last_recovery['indexFailed']=True
        server.check_video_recovery(store,'job','nonce')
        with self.assertRaisesRegex(ValueError,'durable job index'):
            server.check_video_recovery(store)

    def test_missing_encoder_still_claims_ownership_and_starts_recovery(self):
        store = mock.Mock()
        with mock.patch.object(server, 'video_store', return_value=store), \
             mock.patch.object(server, 'FFMPEG_ENCODER_ERROR', 'libx264 unavailable'), \
             mock.patch.object(server.threading, 'Thread') as thread:
            self.assertIs(server.start_video_recovery(), store)
            store.claim_server.assert_called_once()
            self.assertTrue(store.recovery_running)
            self.assertEqual(thread.call_args.kwargs['target'], store.recover_stale_encoders)
            thread.return_value.start.assert_called_once()

    def test_ownership_failure_never_starts_recovery(self):
        store = mock.Mock()
        store.claim_server.side_effect = ValueError('already owned')
        with mock.patch.object(server, 'video_store', return_value=store), \
             mock.patch.object(server.threading, 'Thread') as thread:
            with self.assertRaisesRegex(ValueError, 'already owned'):
                server.start_video_recovery()
            thread.assert_not_called()


if __name__ == '__main__':
    unittest.main()
