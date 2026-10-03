#!/usr/bin/env python3
"""Serve the project and the skybox studio API using only Python's standard library."""
import argparse
import base64
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
FACES = ('px', 'nx', 'py', 'ny', 'pz', 'nz')
EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'}
MAX_BODY = 100 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path != '/api/library':
            return super().do_GET()
        raw = ROOT / 'raw'
        raw.mkdir(exist_ok=True)
        files = []
        for path in sorted(raw.rglob('*')):
            if path.is_file() and path.suffix.lower() in EXTENSIONS and path.resolve().is_relative_to(raw.resolve()):
                content = path.read_bytes()
                files.append({'path': path.relative_to(ROOT).as_posix(), 'bytes': len(content),
                              'sha256': hashlib.sha256(content).hexdigest()})
        self.send_json(200, {'images': files})

    def do_POST(self):
        if self.path != '/api/export':
            return self.send_json(404, {'error': 'Unknown endpoint'})
        # Reject cross-origin requests to this local write API.
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            return self.send_json(403, {'error': 'Cross-origin writes are not allowed'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BODY:
                raise ValueError('Export must be between 1 byte and 100 MB')
            request = json.loads(self.rfile.read(length))
            state = request['state']
            if state.get('schemaVersion') not in (1, 2):
                raise ValueError('Unsupported snapshot schema')
            images = request['images']
            if set(images) != set(FACES):
                raise ValueError('All six faces are required')
            decoded = {}
            for face in FACES:
                decoded[face] = base64.b64decode(images[face], validate=True)
                if not decoded[face].startswith(b'\x89PNG\r\n\x1a\n'):
                    raise ValueError('Faces must be PNG images')
            # Verify the sources still match the snapshot before exporting.
            for node in state['nodes']:
                if node['type'] != 'source':
                    continue
                source = node['source']
                path = (ROOT / source['path']).resolve()
                if not path.is_relative_to((ROOT / 'raw').resolve()) or not path.is_file():
                    raise ValueError('Source is missing or outside raw/: ' + source['path'])
                if hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
                    raise ValueError('Source changed since it was loaded: ' + source['path'])
            label = re.sub(r'[^a-zA-Z0-9_-]+', '-', str(request.get('name', 'skybox')))[:60].strip('-') or 'skybox'
            timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            parent = ROOT / 'exports'
            parent.mkdir(exist_ok=True)
            destination = parent / f'{label}-{timestamp}-{uuid.uuid4().hex[:12]}'
            destination.mkdir(exist_ok=False)
            analysis = request.get('analysis', {})
            manifest = {'schemaVersion': 2, 'createdAt': datetime.now(timezone.utc).isoformat(),
                        'pipeline': state, 'analysis': analysis, 'outputs': {}}
            for face, data in decoded.items():
                (destination / f'{face}.png').write_bytes(data)
                manifest['outputs'][face] = {'file': f'{face}.png', 'sha256': hashlib.sha256(data).hexdigest(),
                                             'faceNode': next(n['id'] for n in state['nodes'] if n['type'] == 'face' and n['face'] == face)}
            (destination / 'pipeline.json').write_text(json.dumps(state, indent=2))
            (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2))
            if analysis:
                (destination / 'analysis.json').write_text(json.dumps(analysis, indent=2))
            self.send_json(201, {'folder': destination.relative_to(ROOT).as_posix()})
        except (ValueError, KeyError, TypeError, StopIteration) as error:
            self.send_json(400, {'error': str(error)})
        except OSError as error:
            self.send_json(500, {'error': str(error)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=1313)
    args = parser.parse_args()
    print(f'Viewer: http://localhost:{args.port}/\nStudio: http://localhost:{args.port}/studio/')
    ThreadingHTTPServer(('localhost', args.port), Handler).serve_forever()
