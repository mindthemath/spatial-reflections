import base64
import hashlib
import http.client
import io
import json
import socket
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path
from http.server import ThreadingHTTPServer

import server

# A minimal 1x1 PNG, sufficient for the API's signature validation.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=')


class StudioAPITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_root = server.ROOT
        self.original_video_store = getattr(server, 'VIDEO_STORE', None)
        if hasattr(server, 'VIDEO_STORE'):
            server.VIDEO_STORE = None
        server.ROOT = Path(self.temp.name)
        (server.ROOT / 'raw').mkdir()
        (server.ROOT / 'raw' / 'photo.png').write_bytes(PNG)
        (server.ROOT / 'index.html').write_text('<script id="piece-config" type="application/json"></script>')
        for filename in ('tesseract.js', 'viewer-skyboxes.js', 'skybox-paths.js', 'visual-music.js', 'visual-music-core.js'):
            (server.ROOT / filename).write_text(f'// {filename}\n')
        (server.ROOT / 'vendor' / 'controls').mkdir(parents=True)
        (server.ROOT / 'vendor' / 'three.module.js').write_text("import './three.core.js';\n")
        (server.ROOT / 'vendor' / 'three.core.js').write_text('// core\n')
        (server.ROOT / 'vendor' / 'controls' / 'OrbitControls.js').write_text('// controls\n')
        (server.ROOT / 'vendor' / 'THREE-LICENSE.txt').write_text('MIT\n')
        self.http = ThreadingHTTPServer(('localhost', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.connection = http.client.HTTPConnection('localhost', self.http.server_port, timeout=10)

    def tearDown(self):
        self.connection.close()
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        if hasattr(server, 'VIDEO_STORE'):
            try:
                server.video_store().pause_all()
            except (OSError, ValueError):
                pass
            server.VIDEO_STORE = self.original_video_store
        server.ROOT = self.original_root
        self.temp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        return self.raw_request(method, path, json.dumps(payload) if payload is not None else None, headers)

    def raw_request(self, method, path, body, headers=None):
        self.connection.request(method, path, body, headers or {})
        response = self.connection.getresponse()
        return response.status, json.loads(response.read())

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

    def test_request_helpers_reuse_connection(self):
        self.request('GET', '/api/video/capabilities')
        first_socket = self.connection.sock
        self.assertIsNotNone(first_socket)
        self.raw_request('GET', '/api/video/capabilities', None)
        self.assertIs(self.connection.sock, first_socket)

    def test_http_connection_is_reused_between_requests(self):
        connection = http.client.HTTPConnection('localhost', self.http.server_port, timeout=10)
        connection.request('GET', '/api/video/capabilities')
        first = connection.getresponse()
        self.assertEqual(first.status, 200)
        first.read()
        first_socket = connection.sock
        self.assertIsNotNone(first_socket)

        connection.request('GET', '/api/video/capabilities')
        second = connection.getresponse()
        self.assertEqual(second.status, 200)
        second.read()
        self.assertIs(connection.sock, first_socket)
        connection.close()

    def payload(self):
        source = {'path': 'raw/photo.png', 'sha256': hashlib.sha256(PNG).hexdigest()}
        nodes = [{'id': 'source', 'type': 'source', 'source': source}]
        nodes += [{'id': face, 'type': 'face', 'face': face} for face in server.FACES]
        return {'name': '../artwork', 'state': {'schemaVersion': 1, 'nodes': nodes, 'edges': []},
                'images': {face: base64.b64encode(PNG).decode() for face in server.FACES}}

    def test_library_and_unique_exports(self):
        code, library = self.request('GET', '/api/library')
        self.assertEqual(code, 200)
        self.assertEqual(library['images'][0]['path'], 'raw/photo.png')
        code, first = self.request('POST', '/api/export', self.payload())
        self.assertEqual(code, 201)
        code, second = self.request('POST', '/api/export', self.payload())
        self.assertEqual(code, 201)
        self.assertNotEqual(first['folder'], second['folder'])
        folder = server.ROOT / first['folder']
        self.assertEqual(len(list(folder.iterdir())), 8)
        manifest = json.loads((folder / 'manifest.json').read_text())
        self.assertEqual(manifest['outputs']['px']['sha256'], hashlib.sha256(PNG).hexdigest())
        self.assertEqual(manifest['outputs']['px']['terminalNode'], 'px')
        self.assertEqual(manifest['outputs']['px']['input'], 'px')

    def test_v2_analysis_export(self):
        payload = self.payload()
        payload['state']['schemaVersion'] = 2
        payload['analysis'] = {'info-node': {'luminance': {'mean': 0.18}, 'samplePixels': 512}}
        code, result = self.request('POST', '/api/export', payload)
        self.assertEqual(code, 201)
        folder = server.ROOT / result['folder']
        analysis = json.loads((folder / 'analysis.json').read_text())
        manifest = json.loads((folder / 'manifest.json').read_text())
        self.assertEqual(manifest['schemaVersion'], 3)
        self.assertEqual(manifest['analysis'], analysis)
        self.assertEqual(analysis['info-node']['luminance']['mean'], 0.18)

    def test_v3_cube_lineage_export(self):
        payload = self.payload()
        payload['state']['schemaVersion'] = 3
        payload['state']['nodes'] = [payload['state']['nodes'][0], {'id': 'cube', 'type': 'skybox'}]
        payload['state']['edges'] = [{'from': 'source', 'to': 'cube', 'input': face} for face in server.FACES]
        code, result = self.request('POST', '/api/export', payload)
        self.assertEqual(code, 201)
        manifest = json.loads((server.ROOT / result['folder'] / 'manifest.json').read_text())
        for face in server.FACES:
            self.assertEqual(manifest['outputs'][face]['terminalNode'], 'cube')
            self.assertEqual(manifest['outputs'][face]['input'], face)

    def test_export_library_lists_only_finished_exports(self):
        payload = self.payload()
        payload['state']['name'] = 'Library artwork'
        payload['state']['size'] = 512
        code, finished = self.request('POST', '/api/export', payload)
        self.assertEqual(code, 201)
        self.request('POST', '/api/export/start', {'name': 'pending', 'state': payload['state']})
        code, library = self.request('GET', '/api/exports')
        self.assertEqual(code, 200)
        self.assertEqual(len(library['exports']), 1)
        entry = library['exports'][0]
        self.assertEqual(entry['folder'], finished['folder'])
        self.assertEqual(entry['name'], 'Library artwork')
        self.assertEqual(entry['sourceCount'], 1)
        self.assertEqual(entry['size'], 512)
        self.assertEqual(entry['thumbnail'], 'px.png')

    def test_streamed_export(self):
        payload = self.payload()
        code, started = self.request('POST', '/api/export/start', {'name': 'large-art', 'state': payload['state']})
        self.assertEqual(code, 201)
        folder = started['folder']
        for face in server.FACES:
            connection = http.client.HTTPConnection('localhost', self.http.server_port, timeout=10)
            connection.request('POST', f'/api/export/face?folder={folder}&face={face}', PNG, {'Content-Type': 'image/png'})
            response = connection.getresponse()
            self.assertEqual(response.status, 201)
            response.read()
            connection.close()
        code, finished = self.request('POST', '/api/export/finish', {'folder': folder, 'analysis': {}})
        self.assertEqual(code, 201)
        destination = server.ROOT / finished['folder']
        self.assertTrue((destination / 'pipeline.json').is_file())
        self.assertFalse((destination / '.pending.json').exists())
        # A completed folder can never receive another face or be finalized again.
        code, _ = self.request('POST', '/api/export/finish', {'folder': folder})
        self.assertEqual(code, 400)

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

    def test_publish_creates_standalone_work_and_catalog(self):
        payload = self.payload()
        payload['state']['name'] = 'Mirror Study'
        payload['state']['size'] = 1024
        code, exported = self.request('POST', '/api/export', payload)
        self.assertEqual(code, 201)
        publish = {'slug': 'mirror-study', 'title': 'Mirror <Study>', 'description': 'A finished work.',
                   'exportFolder': exported['folder'], 'viewerState': {'shader': 'chrome', 'camera': {}}}
        code, result = self.request('POST', '/api/publish', publish)
        self.assertEqual(code, 201)
        self.assertEqual(result['url'], '/site/work/mirror-study/')
        folder = server.ROOT / result['folder']
        self.assertTrue(all((folder / 'skybox' / f'{face}.png').is_file() for face in server.FACES))
        self.assertTrue((folder / 'tesseract.js').is_file())
        self.assertTrue((folder / 'vendor' / 'three.module.js').is_file())
        self.assertTrue((folder / 'vendor' / 'three.core.js').is_file())
        self.assertTrue((folder / 'vendor' / 'controls' / 'OrbitControls.js').is_file())
        self.assertNotIn('<Study>', (folder / 'index.html').read_text())
        piece = json.loads((folder / 'piece.json').read_text())
        self.assertEqual(piece['viewer']['shader'], 'chrome')
        catalog = json.loads((server.ROOT / 'site' / 'catalog.json').read_text())
        self.assertEqual(catalog['work'][0]['url'], 'work/mirror-study/')
        self.assertEqual(self.request('POST', '/api/publish', publish)[0], 400)

    def test_studio_code_bypasses_cache(self):
        (server.ROOT / 'studio').mkdir()
        (server.ROOT / 'studio' / 'app.js').write_text('const version = 3;')
        connection = http.client.HTTPConnection('localhost', self.http.server_port, timeout=10)
        connection.request('GET', '/studio/app.js', headers={'If-Modified-Since': 'Wed, 01 Jan 2099 00:00:00 GMT'})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Cache-Control'), 'no-store')
        self.assertIn(b'version = 3', response.read())
        connection.close()

    def test_changed_source_rejected(self):
        payload = self.payload()
        (server.ROOT / 'raw' / 'photo.png').write_bytes(PNG + b'changed')
        code, result = self.request('POST', '/api/export', payload)
        self.assertEqual(code, 400)
        self.assertIn('Source changed', result['error'])
        self.assertFalse((server.ROOT / 'exports').exists())

    def test_path_escape_rejected(self):
        payload = self.payload()
        payload['state']['nodes'][0]['source']['path'] = '../outside.png'
        code, _ = self.request('POST', '/api/export', payload)
        self.assertEqual(code, 400)

    def test_missing_face_rejected(self):
        payload = self.payload()
        del payload['images']['px']
        self.assertEqual(self.request('POST', '/api/export', payload)[0], 400)

    def test_cross_origin_rejected(self):
        self.assertEqual(self.request('POST', '/api/export', self.payload(), {'Origin': 'https://example.com'})[0], 403)

    def test_rejected_request_with_unread_body_closes_connection(self):
        connection = http.client.HTTPConnection('localhost', self.http.server_port, timeout=10)
        connection.request('POST', '/api/export', json.dumps(self.payload()), {'Origin': 'https://example.com'})
        response = connection.getresponse()
        self.assertEqual(response.status, 403)
        response.read()
        self.assertIsNone(connection.sock)


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
