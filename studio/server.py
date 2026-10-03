#!/usr/bin/env python3
"""Serve the viewer and Studio, and write collision-free local exports."""
import argparse
import base64
import hashlib
import json
import re
import shutil
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


def completed_export(folder_name):
    if not isinstance(folder_name, str):
        raise ValueError('Invalid export folder')
    match = re.fullmatch(r'/?exports/([a-zA-Z0-9_-]+)/?', folder_name)
    if not match:
        raise ValueError('Publish a completed folder inside exports/')
    parent = (ROOT / 'exports').resolve()
    folder = (parent / match.group(1)).resolve()
    if folder.parent != parent or (folder / '.pending.json').exists() or not (folder / 'manifest.json').is_file():
        raise ValueError('Export is missing or incomplete')
    manifest = json.loads((folder / 'manifest.json').read_text())
    if set(manifest.get('outputs', {})) != set(FACES):
        raise ValueError('Export manifest does not contain all six faces')
    for face in FACES:
        path = folder / f'{face}.png'
        output = manifest['outputs'][face]
        if output.get('file') != path.name or not path.is_file():
            raise ValueError(f'Export face is missing: {face}')
        if output.get('sha256') != hash_file(path):
            raise ValueError(f'Export face changed after completion: {face}')
    return folder, manifest


def rebuild_catalog():
    site = ROOT / 'site'
    work = site / 'work'
    entries = []
    if work.exists():
        for metadata in work.glob('*/piece.json'):
            try:
                piece = json.loads(metadata.read_text())
                slug = metadata.parent.name
                if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', slug) or piece.get('slug') != slug:
                    continue
                entries.append({'slug': slug, 'title': piece['title'], 'description': piece.get('description', ''),
                                'publishedAt': piece['publishedAt'], 'url': f'work/{slug}/',
                                'thumbnail': f'work/{slug}/preview.png'})
            except (OSError, ValueError, KeyError, TypeError):
                continue
    entries.sort(key=lambda item: item['publishedAt'], reverse=True)
    site.mkdir(exist_ok=True)
    temporary = site / f'.catalog-{uuid.uuid4().hex}.json'
    temporary.write_text(json.dumps({'schemaVersion': 1, 'work': entries}, indent=2) + '\n')
    temporary.replace(site / 'catalog.json')


def publish_work(request):
    title = str(request.get('title', '')).strip()
    description = str(request.get('description', '')).strip()
    slug = str(request.get('slug', '')).strip()
    state = request.get('viewerState')
    if not title or len(title) > 100:
        raise ValueError('Title must be between 1 and 100 characters')
    if len(description) > 1000:
        raise ValueError('Description must be at most 1000 characters')
    if len(slug) > 60 or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        raise ValueError('Slug must use lowercase letters and numbers separated by single hyphens')
    if not isinstance(state, dict):
        raise ValueError('Viewer state is required')
    folder, manifest = completed_export(request.get('exportFolder'))
    required = [ROOT / name for name in ('index.html', 'tesseract.js', 'viewer-skyboxes.js', 'skybox-paths.js')]
    vendor = ROOT / 'vendor'
    vendor_files = (vendor / 'three.module.js', vendor / 'controls' / 'OrbitControls.js', vendor / 'THREE-LICENSE.txt')
    if any(not path.is_file() for path in (*required, *vendor_files)):
        raise ValueError('Viewer runtime files are missing')

    work = ROOT / 'site' / 'work'
    work.mkdir(parents=True, exist_ok=True)
    destination = work / slug
    if destination.exists():
        raise ValueError(f'site/work/{slug}/ already exists; choose another slug')
    temporary = work / f'.{slug}-{uuid.uuid4().hex}.pending'
    temporary.mkdir()
    try:
        (temporary / 'skybox').mkdir()
        for face in FACES:
            shutil.copy2(folder / f'{face}.png', temporary / 'skybox' / f'{face}.png')
        preview = folder / 'preview.png'
        shutil.copy2(preview if preview.is_file() else folder / 'px.png', temporary / 'preview.png')
        for source in required[1:]:
            shutil.copy2(source, temporary / source.name)
        shutil.copytree(vendor, temporary / 'vendor')
        published_at = datetime.now(timezone.utc).isoformat()
        piece = {'schemaVersion': 1, 'slug': slug, 'title': title, 'description': description,
                 'publishedAt': published_at, 'size': manifest.get('pipeline', {}).get('size'),
                 'skybox': {face: f'skybox/{face}.png' for face in FACES}, 'viewer': state,
                 'source': {'export': folder.relative_to(ROOT.resolve()).as_posix(),
                            'manifestSha256': hash_file(folder / 'manifest.json')}}
        html = required[0].read_text()
        marker = '<script id="piece-config" type="application/json"></script>'
        if html.count(marker) != 1:
            raise ValueError('Viewer index is missing its publication configuration slot')
        embedded = json.dumps(piece, separators=(',', ':')).replace('<', '\\u003c')
        (temporary / 'index.html').write_text(html.replace(marker, f'<script id="piece-config" type="application/json">{embedded}</script>'))
        (temporary / 'piece.json').write_text(json.dumps(piece, indent=2) + '\n')
        temporary.replace(destination)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    rebuild_catalog()
    return {'slug': slug, 'folder': destination.relative_to(ROOT).as_posix(), 'url': f'/site/work/{slug}/'}


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
    if (folder / 'preview.png').is_file():
        manifest['thumbnail'] = 'preview.png'
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
        if urlparse(self.path).path.startswith(('/studio/', '/api/')) or urlparse(self.path).path in ('/', '/index.html', '/tesseract.js', '/viewer-skyboxes.js', '/skybox-paths.js'):
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
        if path.startswith('/studio/') or path in ('/', '/index.html', '/tesseract.js', '/viewer-skyboxes.js', '/skybox-paths.js'):
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
        if path == '/api/exports':
            exports = []
            parent = ROOT / 'exports'
            if parent.exists():
                for folder in parent.iterdir():
                    if not folder.is_dir() or not folder.resolve().is_relative_to(parent.resolve()) or not re.fullmatch(r'[a-zA-Z0-9_-]+', folder.name):
                        continue
                    if (folder / '.pending.json').exists() or not (folder / 'manifest.json').is_file():
                        continue
                    try:
                        manifest = json.loads((folder / 'manifest.json').read_text())
                        if set(manifest['outputs']) != set(FACES) or not all((folder / f'{face}.png').is_file() for face in FACES):
                            continue
                        pipeline = manifest['pipeline']
                        exports.append({'folder': f'exports/{folder.name}', 'name': pipeline.get('name', folder.name),
                                        'createdAt': manifest.get('createdAt', ''), 'size': pipeline.get('size'),
                                        'sourceCount': len({n['source']['path'] for n in pipeline['nodes'] if n['type'] == 'source'}),
                                        'thumbnail': 'preview.png' if (folder / 'preview.png').is_file() else 'px.png'})
                    except (OSError, ValueError, KeyError, TypeError):
                        continue
            exports.sort(key=lambda item: item['createdAt'], reverse=True)
            return self.send_json(200, {'exports': exports})
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
        if route.path not in ('/api/export', '/api/export/start', '/api/export/face', '/api/export/finish', '/api/publish'):
            return self.send_json(404, {'error': 'Unknown endpoint'})
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            return self.send_json(403, {'error': 'Cross-origin writes are not allowed'})
        try:
            if route.path == '/api/export/face':
                query = parse_qs(route.query)
                folder = pending_folder(query.get('folder', [''])[0])
                face = query.get('face', [''])[0]
                if face not in (*FACES, 'preview'):
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
            if route.path == '/api/publish':
                return self.send_json(201, publish_work(request))
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
