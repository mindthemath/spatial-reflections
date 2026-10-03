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


class StudioAPITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original_root = server.ROOT
        server.ROOT = Path(self.temp.name)
        (server.ROOT / 'raw').mkdir()
        (server.ROOT / 'raw' / 'photo.png').write_bytes(PNG)
        self.http = ThreadingHTTPServer(('localhost', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()
        server.ROOT = self.original_root
        self.temp.cleanup()

    def request(self, method, path, payload=None, headers=None):
        connection = http.client.HTTPConnection('localhost', self.http.server_port)
        connection.request(method, path, json.dumps(payload) if payload is not None else None, headers or {})
        response = connection.getresponse()
        status, data = response.status, json.loads(response.read())
        connection.close()
        return status, data

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
        self.assertEqual(manifest['outputs']['px']['faceNode'], 'px')

    def test_v2_analysis_export(self):
        payload = self.payload()
        payload['state']['schemaVersion'] = 2
        payload['analysis'] = {'info-node': {'luminance': {'mean': 0.18}, 'samplePixels': 512}}
        code, result = self.request('POST', '/api/export', payload)
        self.assertEqual(code, 201)
        folder = server.ROOT / result['folder']
        analysis = json.loads((folder / 'analysis.json').read_text())
        manifest = json.loads((folder / 'manifest.json').read_text())
        self.assertEqual(manifest['schemaVersion'], 2)
        self.assertEqual(manifest['analysis'], analysis)
        self.assertEqual(analysis['info-node']['luminance']['mean'], 0.18)

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


if __name__ == '__main__':
    unittest.main()
