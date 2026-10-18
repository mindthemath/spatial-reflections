# Copyright 2026 Michael Pilosov. All rights reserved.
import base64
import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer

import server

# A minimal 1x1 PNG, sufficient for the API's signature validation.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=')


class ServerAPITestCase(unittest.TestCase):
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
        (server.ROOT / 'SOURCE_RIGHTS.txt').write_text('Copyright 2026 Michael Pilosov. All rights reserved.\n')
        (server.ROOT / 'DISTRIBUTION_RIGHTS.txt').write_text('Copyright 2026 Michael Pilosov. All rights reserved.\n')
        for filename in ('tesseract.js', 'viewer-skyboxes.js', 'skybox-paths.js', 'visual-music.js', 'visual-music-core.js'):
            (server.ROOT / filename).write_text(f'// {filename}\n')
        (server.ROOT / 'vendor' / 'controls').mkdir(parents=True)
        (server.ROOT / 'vendor' / 'three.module.js').write_text("import './three.core.js';\n")
        (server.ROOT / 'vendor' / 'three.core.js').write_text('// core\n')
        (server.ROOT / 'vendor' / 'controls' / 'OrbitControls.js').write_text('// controls\n')
        (server.ROOT / 'vendor' / 'THREE-LICENSE.txt').write_text('MIT\n')
        self.http = ThreadingHTTPServer(('localhost', 0), server.Handler)
        # Keep per-test shutdown responsive; production polling is unchanged.
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
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


    def payload(self):
        source = {'path': 'raw/photo.png', 'sha256': hashlib.sha256(PNG).hexdigest()}
        nodes = [{'id': 'source', 'type': 'source', 'source': source}]
        nodes += [{'id': face, 'type': 'face', 'face': face} for face in server.FACES]
        return {'name': '../artwork', 'state': {'schemaVersion': 1, 'nodes': nodes, 'edges': []},
                'images': {face: base64.b64encode(PNG).decode() for face in server.FACES}}


