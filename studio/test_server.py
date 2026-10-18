# Copyright 2026 Michael Pilosov. All rights reserved.
import base64
import hashlib
import http.client
import json
import unittest

import server

# A minimal 1x1 PNG, sufficient for the API's signature validation.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=')


from server_test_fixture import ServerAPITestCase


class StudioAPITest(ServerAPITestCase):
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
        self.assertFalse((folder / 'preview.png').exists())
        self.assertEqual((folder / 'SOURCE_RIGHTS.txt').read_text(), 'Copyright 2026 Michael Pilosov. All rights reserved.\n')
        self.assertEqual((folder / 'DISTRIBUTION_RIGHTS.txt').read_text(), 'Copyright 2026 Michael Pilosov. All rights reserved.\n')
        self.assertTrue((folder / 'vendor' / 'three.module.js').is_file())
        self.assertTrue((folder / 'vendor' / 'three.core.js').is_file())
        self.assertTrue((folder / 'vendor' / 'controls' / 'OrbitControls.js').is_file())
        self.assertNotIn('<Study>', (folder / 'index.html').read_text())
        piece = json.loads((folder / 'piece.json').read_text())
        self.assertEqual(piece['viewer']['shader'], 'chrome')
        catalog = json.loads((server.ROOT / 'site' / 'catalog.json').read_text())
        self.assertEqual(catalog['work'][0]['url'], 'work/mirror-study/')
        self.assertEqual(catalog['work'][0]['thumbnail'], '')
        self.assertEqual(self.request('POST', '/api/publish', publish)[0], 400)

        (server.ROOT / 'tesseract.js').write_text('// updated runtime\n')
        self.assertEqual(server.refresh_published_runtime(), ['mirror-study'])
        self.assertEqual((folder / 'tesseract.js').read_text(), '// updated runtime\n')
        self.assertEqual(json.loads((folder / 'piece.json').read_text()), piece)
        self.assertIn('"slug":"mirror-study"', (folder / 'index.html').read_text())
        self.assertTrue(all((folder / 'skybox' / f'{face}.png').is_file() for face in server.FACES))
        self.assertEqual([path.name for path in (server.ROOT / 'site' / 'work').iterdir()], ['mirror-study'])


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


if __name__ == '__main__':
    unittest.main()
