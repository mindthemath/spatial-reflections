#!/usr/bin/env python3
"""Serve the viewer and Studio, and write collision-free local exports."""
import argparse
import base64
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
FACES = ('px', 'nx', 'py', 'ny', 'pz', 'nz')
EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'}
MAX_BODY = 100 * 1024 * 1024  # Legacy JSON export limit; Studio uses streamed PNG uploads.
MAX_FACE_BYTES = 512 * 1024 * 1024
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def hash_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_pipeline(state):
    if state.get('schemaVersion') not in (1, 2, 3):
        raise ValueError('Unsupported snapshot schema')
    if state['schemaVersion'] == 3:
        cubes = [n for n in state['nodes'] if n['type'] == 'skybox']
        if len(cubes) != 1:
            raise ValueError('Exactly one permanent skybox output is required')
        connections = [e for e in state['edges'] if e['to'] == cubes[0]['id']]
        if len(connections) != 6 or {e.get('input') for e in connections} != set(FACES):
            raise ValueError('The skybox must have all six named inputs connected')
    for node in state['nodes']:
        if node['type'] != 'source':
            continue
        source = node['source']
        path = (ROOT / source['path']).resolve()
        if not path.is_relative_to((ROOT / 'raw').resolve()) or not path.is_file():
            raise ValueError('Source is missing or outside raw/: ' + source['path'])
        if hash_file(path) != source['sha256']:
            raise ValueError('Source changed since it was loaded: ' + source['path'])


def start_export(name, state):
    verify_pipeline(state)
    label = re.sub(r'[^a-zA-Z0-9_-]+', '-', str(name))[:60].strip('-') or 'skybox'
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    parent = ROOT / 'exports'
    parent.mkdir(exist_ok=True)
    destination = parent / f'{label}-{timestamp}-{uuid.uuid4().hex[:12]}'
    destination.mkdir(exist_ok=False)
    (destination / '.pending.json').write_text(json.dumps(state))
    return destination


def pending_folder(name):
    # Only an exclusively created, unfinished export can receive PNGs.
    if not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+', name):
        raise ValueError('Invalid export folder')
    parent = (ROOT / 'exports').resolve()
    folder = (parent / name).resolve()
    if folder.parent != parent or not (folder / '.pending.json').is_file():
        raise ValueError('Export is missing or already complete')
    return folder


def finish_export(folder, analysis):
    state = json.loads((folder / '.pending.json').read_text())
    verify_pipeline(state)  # Recheck after rendering, not just when the export started.
    cube = next((n for n in state['nodes'] if n['type'] == 'skybox'), None)
    outputs = {}
    for face in FACES:
        path = folder / f'{face}.png'
        if not path.is_file():
            raise ValueError(f'Missing exported face: {face}')
        terminal = cube['id'] if cube else next(n['id'] for n in state['nodes'] if n['type'] == 'face' and n['face'] == face)
        outputs[face] = {'file': path.name, 'sha256': hash_file(path), 'terminalNode': terminal, 'input': face}
    manifest = {'schemaVersion': 3, 'createdAt': datetime.now(timezone.utc).isoformat(),
                'pipeline': state, 'analysis': analysis, 'outputs': outputs}
    for filename, value in [('pipeline.json', state), ('manifest.json', manifest)]:
        with (folder / filename).open('x') as stream:
            json.dump(value, stream, indent=2)
    if analysis:
        with (folder / 'analysis.json').open('x') as stream:
            json.dump(analysis, stream, indent=2)
    (folder / '.pending.json').unlink()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if urlparse(self.path).path.startswith(('/studio/', '/api/')):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_BODY:
            raise ValueError('JSON request must be between 1 byte and 100 MB')
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith('/studio/'):
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
        if path != '/api/library':
            return super().do_GET()
        raw = ROOT / 'raw'
        raw.mkdir(exist_ok=True)
        files = []
        for path in sorted(raw.rglob('*')):
            if path.is_file() and path.suffix.lower() in EXTENSIONS and path.resolve().is_relative_to(raw.resolve()):
                files.append({'path': path.relative_to(ROOT).as_posix(), 'bytes': path.stat().st_size,
                              'sha256': hash_file(path)})
        self.send_json(200, {'images': files})

    def do_POST(self):
        route = urlparse(self.path)
        if route.path not in ('/api/export', '/api/export/start', '/api/export/face', '/api/export/finish'):
            return self.send_json(404, {'error': 'Unknown endpoint'})
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            return self.send_json(403, {'error': 'Cross-origin writes are not allowed'})
        try:
            if route.path == '/api/export/face':
                query = parse_qs(route.query)
                folder = pending_folder(query.get('folder', [''])[0])
                face = query.get('face', [''])[0]
                if face not in FACES:
                    raise ValueError('Invalid cube face')
                length = int(self.headers.get('Content-Length', '0'))
                if not 8 <= length <= MAX_FACE_BYTES:
                    raise ValueError('PNG must be between 8 bytes and 512 MB')
                signature = self.rfile.read(8)
                if signature != PNG_SIGNATURE:
                    raise ValueError('Face must be a PNG image')
                path = folder / f'{face}.png'
                # Exclusive writes: a face cannot overwrite a previous upload.
                with path.open('xb') as stream:
                    stream.write(signature)
                    remaining = length - 8
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError('Incomplete PNG upload')
                        stream.write(chunk)
                        remaining -= len(chunk)
                return self.send_json(201, {'face': face})
            request = self.read_json()
            if route.path == '/api/export/start':
                folder = start_export(request.get('name', 'skybox'), request['state'])
                return self.send_json(201, {'folder': folder.name})
            if route.path == '/api/export/finish':
                folder = pending_folder(request['folder'])
                finish_export(folder, request.get('analysis', {}))
                return self.send_json(201, {'folder': folder.relative_to(ROOT.resolve()).as_posix()})
            # Compatibility endpoint for older clients; all filesystem checks are shared.
            images = request['images']
            if set(images) != set(FACES):
                raise ValueError('All six faces are required')
            decoded = {face: base64.b64decode(images[face], validate=True) for face in FACES}
            if any(not data.startswith(PNG_SIGNATURE) for data in decoded.values()):
                raise ValueError('Faces must be PNG images')
            folder = start_export(request.get('name', 'skybox'), request['state'])
            for face, data in decoded.items():
                with (folder / f'{face}.png').open('xb') as stream:
                    stream.write(data)
            finish_export(folder, request.get('analysis', {}))
            self.send_json(201, {'folder': folder.relative_to(ROOT).as_posix()})
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
