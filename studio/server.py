#!/usr/bin/env python3
# Copyright 2026 Michael Pilosov. All rights reserved.
"""Serve the viewer and Studio, and write collision-free local exports."""
import argparse
import atexit
import base64
import hashlib
import json
import re
import shutil
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    from .video_audio import MAX_AUDIO_BYTES, validate_music_request, validate_wave
    from .video_encoding import MASTER_ENCODING
except ImportError:
    from video_audio import MAX_AUDIO_BYTES, validate_music_request, validate_wave
    from video_encoding import MASTER_ENCODING

# Lazy selection keeps the simple fallback independent of the resume module.
VideoJobStore = None
VIDEO_MODE = 'resumable'

ROOT = Path(__file__).resolve().parent.parent
FACES = ('px', 'nx', 'py', 'ny', 'pz', 'nz')
EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'}
MAX_BODY = 100 * 1024 * 1024  # Legacy JSON export limit; Studio uses streamed PNG uploads.
MAX_FACE_BYTES = 512 * 1024 * 1024
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
# Master uses CRF rather than this planning rate; its deliberately conservative
# factor is used only for disk/size estimates before the content-dependent encode.
VIDEO_QUALITIES = {'draft': 0.035, 'standard': 0.07, 'high': 0.12, 'master': 0.8}
VIDEO_FORMATS = ('mp4', 'mkv')
MAX_VIDEO_FRAME_BYTES = 100 * 1024 * 1024
MAX_VIDEO_FRAMES = 10_000_000
VIDEO_FRAME_READ_TIMEOUT = 30
VIDEO_STORE = None
VIDEO_STORE_LOCK = threading.Lock()
FFMPEG_ENCODER_ERROR = None
FFMPEG_AUDIO_ENCODER_ERROR = None
# None means an embedded/test server has not run CLI startup. CLI startup pins
# its binary (or its absence); changing it requires ownership/recovery preflight.
VIDEO_FFMPEG_BOOTSTRAP = None


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
    asset_size = request.get('assetSize', 'original')
    asset_format = request.get('assetFormat', 'png')
    asset_quality = float(request.get('assetQuality', 0.88))
    if asset_size != 'original':
        try: asset_size = int(asset_size)
        except (TypeError, ValueError): raise ValueError('Invalid published image size')
        if asset_size not in (2048, 4096): raise ValueError('Invalid published image size')
    if asset_format not in ('png', 'jpg'): raise ValueError('Invalid published image format')
    if not 0.5 <= asset_quality <= 1: raise ValueError('JPEG quality must be between 0.50 and 1.00')
    source_size = manifest.get('pipeline', {}).get('size')
    published_size = source_size if asset_size == 'original' else min(source_size or asset_size, asset_size)
    required = [ROOT / name for name in ('index.html', 'tesseract.js', 'viewer-skyboxes.js', 'skybox-paths.js',
                                          'visual-music.js', 'visual-music-core.js', 'SOURCE_RIGHTS.txt',
                                          'DISTRIBUTION_RIGHTS.txt')]
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
        skybox_files = {}
        for face in FACES:
            source = folder / manifest['outputs'][face]['file']
            extension = 'png' if asset_format == 'png' else 'jpg'
            target = temporary / 'skybox' / f'{face}.{extension}'
            if asset_size == 'original' and asset_format == 'png':
                shutil.copy2(source, target)
            else:
                scale = 'iw' if asset_size == 'original' else str(asset_size)
                quality = max(2, min(31, round(31 - 29 * asset_quality)))
                command = ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(source), '-vf', f'scale={scale}:{scale}:force_original_aspect_ratio=decrease']
                if extension == 'jpg': command += ['-q:v', str(quality)]
                command += [str(target)]
                try: subprocess.run(command, check=True, capture_output=True, text=True)
                except (OSError, subprocess.CalledProcessError) as error: raise ValueError(f'Could not encode published face: {face}') from error
            skybox_files[face] = f'skybox/{target.name}'
        preview = folder / 'preview.png'
        shutil.copy2(preview if preview.is_file() else folder / 'px.png', temporary / 'preview.png')
        for source in required[1:]:
            shutil.copy2(source, temporary / source.name)
        shutil.copytree(vendor, temporary / 'vendor')
        published_at = datetime.now(timezone.utc).isoformat()
        piece = {'schemaVersion': 1, 'slug': slug, 'title': title, 'description': description,
                 'publishedAt': published_at, 'size': published_size,
                 'skybox': skybox_files, 'viewer': state,
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


def video_clip_labels():
    parent = ROOT / 'videos'
    labels = []
    if not parent.is_dir():
        return labels
    pattern = re.compile(r'^(.+)-\d{8}T\d{6}Z-[a-f0-9]{8}\.(?:mp4|mkv)$')
    for path in sorted((*parent.glob('*.mp4'), *parent.glob('*.mkv'))):
        if not path.is_file() or path.name.startswith('.') or not path.resolve().is_relative_to(parent.resolve()):
            continue
        match = pattern.fullmatch(path.name)
        if match:
            labels.append(match.group(1))
    return labels


def ffmpeg_encoder_error(ffmpeg):
    try:
        completed = subprocess.run(
            [str(ffmpeg), '-hide_banner', '-encoders'],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return f'Could not inspect ffmpeg encoders: {error}'
    if completed.returncode != 0:
        return 'ffmpeg could not list its encoders'
    if not re.search(r'^\s*V\S*\s+libx264\s', completed.stdout, re.MULTILINE):
        return 'ffmpeg does not provide the required libx264 H.264 encoder'
    return None


def ffmpeg_audio_encoder_error(ffmpeg):
    try:
        completed = subprocess.run(
            [str(ffmpeg), '-hide_banner', '-encoders'],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return f'Could not inspect ffmpeg audio encoders: {error}'
    if completed.returncode != 0:
        return 'ffmpeg could not list its audio encoders'
    if not re.search(r'^\s*A\S*\s+aac\s', completed.stdout, re.MULTILINE):
        return 'ffmpeg does not provide the required AAC audio encoder'
    return None


def video_capabilities():
    ffmpeg = shutil.which('ffmpeg')
    recovery = {
        'recovered': 0, 'alreadyExited': 0, 'refused': 0,
        'skippedActive': 0, 'failed': 0, 'indexFailed': False,
    }
    available = bool(ffmpeg) and not FFMPEG_ENCODER_ERROR
    reason = (FFMPEG_ENCODER_ERROR if ffmpeg
              else 'ffmpeg is not installed or is not on the server PATH')
    store = None
    if ffmpeg:
        try:
            store = video_store()
        except (ValueError, OSError) as error:
            available = False
            reason = str(error)
        if store is not None:
            if (not store.recovery_running and
                    (store.recovery_pending is True or (store.last_recovery['failed']
                     and not store.last_recovery['indexFailed']))):
                store.recover_stale_encoders()
            recovery = store.last_recovery
            if store.recovery_running:
                available = False
                reason = 'Encoder startup recovery is still running; retry in a moment'
            elif recovery['indexFailed']:
                available = False
                reason = 'Encoder startup recovery could not inspect the durable job index'
    can_manage = store is not None and not (store.recovery_running or recovery['indexFailed'])
    return {'available': available, 'canManage': can_manage, 'videoMode': VIDEO_MODE,
            'resumable': VIDEO_MODE == 'resumable', 'encoder': 'H.264 / MP4 or MKV' if ffmpeg else None,
            'musicAvailable': available and not FFMPEG_AUDIO_ENCODER_ERROR,
            'musicReason': FFMPEG_AUDIO_ENCODER_ERROR,
            'qualities': list(VIDEO_QUALITIES), 'formats': list(VIDEO_FORMATS),
            'freeBytes': shutil.disk_usage(ROOT).free,
            'clips': video_clip_labels(),
            'encoderRecovery': recovery,
            'reason': reason}


def check_video_recovery(store, job_id=None, lease=None):
    reason = ('Encoder recovery is still running; retry preflight before modifying jobs'
              if store.recovery_running else
              'Encoder startup recovery could not inspect the durable job index'
              if store.last_recovery['indexFailed'] else None)
    if not reason:
        return
    # A background repair pass skips live owner locks. Do not interrupt healthy
    # uploads or their pause requests; an old tab after restart has no valid lease.
    with store.lock:
        active = store.leases.get(job_id)
        if lease and active and active['token'] == lease and job_id in store.owners:
            return
    raise ValueError(reason)


def start_video_recovery():
    # Ownership and crash recovery are required even when this ffmpeg cannot
    # encode new H.264 frames. Existing jobs can still be managed/stream-copied.
    store = video_store()
    store.claim_server()
    if VIDEO_MODE == 'simple':
        return
    store.recovery_running = True
    threading.Thread(target=store.recover_stale_encoders,
                     name='video-encoder-recovery', daemon=True).start()
    return store


def video_store(for_control=False):
    global VIDEO_STORE
    if for_control:
        with VIDEO_STORE_LOCK:
            if VIDEO_STORE is not None and VIDEO_STORE.root == ROOT.resolve():
                return VIDEO_STORE
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise ValueError('Video export requires ffmpeg on the local server PATH')
    root = ROOT.resolve()
    if (VIDEO_FFMPEG_BOOTSTRAP is not None
            and str(Path(ffmpeg).resolve()) != VIDEO_FFMPEG_BOOTSTRAP):
        raise ValueError('Restart the Studio server after installing or changing ffmpeg')
    with VIDEO_STORE_LOCK:
        if VIDEO_STORE is None or VIDEO_STORE.root != root or VIDEO_STORE.ffmpeg != str(ffmpeg):
            if VIDEO_STORE is not None:
                VIDEO_STORE.pause_all()
            if VIDEO_MODE == 'simple':
                from video_simple import SimpleVideoBackend
                factory = SimpleVideoBackend
            else:
                factory = VideoJobStore
                if factory is None:
                    from video_resume import VideoJobStore as factory
            VIDEO_STORE = factory(root, ffmpeg)
        # Keep dependency injection and unittest patches applied to subprocess.
        VIDEO_STORE.popen = subprocess.Popen
        VIDEO_STORE.run = subprocess.run
        return VIDEO_STORE


def validate_video_request(request):
    width = int(request.get('width', 0))
    height = int(request.get('height', 0))
    fps = int(request.get('fps', 0))
    frames = int(request.get('frames', 0))
    quality = request.get('quality', 'standard')
    video_format = request.get('format', 'mp4')
    if width < 64 or height < 64 or width > 7680 or height > 4320 or width % 2 or height % 2:
        raise ValueError('Video dimensions must be even and between 64×64 and 7680×4320')
    if fps not in (24, 25, 30, 50, 60):
        raise ValueError('Unsupported video frame rate')
    if frames < 1 or frames > MAX_VIDEO_FRAMES:
        raise ValueError(f'Video must contain between 1 and {MAX_VIDEO_FRAMES:,} frames')
    if quality not in VIDEO_QUALITIES:
        raise ValueError('Unsupported video quality')
    if video_format not in VIDEO_FORMATS:
        raise ValueError('Unsupported video format')
    bit_rate = round(width * height * fps * VIDEO_QUALITIES[quality])
    estimate = round(bit_rate * (frames / fps) / 8 * 1.03)
    return width, height, fps, frames, quality, video_format, bit_rate, estimate


def start_video(request):
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise ValueError('Video export requires ffmpeg on the local server PATH')
    if FFMPEG_ENCODER_ERROR:
        raise ValueError(FFMPEG_ENCODER_ERROR)
    store = video_store()
    if store.recovery_running:
        raise ValueError('Encoder startup recovery is still running')
    if store.last_recovery['indexFailed']:
        raise ValueError('Encoder startup recovery failed; inspect the video job index')
    width, height, fps, frames, quality, video_format, bit_rate, estimate = validate_video_request(request)
    request = {**request, 'width': width, 'height': height, 'fps': fps, 'frames': frames}
    if quality == 'master':
        request['encoding'] = dict(MASTER_ENCODING)
    else:
        request.pop('encoding', None)
    music = validate_music_request(request)
    if music:
        if FFMPEG_AUDIO_ENCODER_ERROR:
            raise ValueError(FFMPEG_AUDIO_ENCODER_ERROR)
        request['music'] = music
    else:
        request.pop('music', None)
    audio_bytes = (music['samples'] * music['channels'] * 2 + 44) if music else 0
    if VIDEO_MODE == 'simple':
        parent = ROOT / 'videos'
        parent.mkdir(exist_ok=True)
        if estimate * (2 if music else 1) + audio_bytes > shutil.disk_usage(parent).free * 0.9:
            raise ValueError('Estimated video and soundtrack exceed output disk space')
        active = store.start({**request, 'quality': quality, 'format': video_format,
                              'bitRate': bit_rate, 'estimatedBytes': estimate,
                              'checkpointSeconds': 0, 'scratchPath': '',
                              'colorProfile': 'srgb-limited-v1'})
        active.update({'estimatedBytes': estimate, 'bitRate': bit_rate})
        return active
    checkpoint_seconds = int(request.get('checkpointSeconds', 60))
    request = {
        **request, 'width': width, 'height': height, 'fps': fps,
        'frames': frames, 'quality': quality, 'format': video_format,
        'bitRate': bit_rate, 'estimatedBytes': estimate,
        'checkpointSeconds': checkpoint_seconds,
    }
    parent = ROOT / 'videos'
    parent.mkdir(exist_ok=True)
    configured_scratch = request.get('scratchPath')
    if configured_scratch is not None and not isinstance(configured_scratch, str):
        raise ValueError('Video scratch path must be text')
    scratch = (Path(configured_scratch).expanduser() if str(configured_scratch or '').strip()
               else parent / '.checkpoints')
    if configured_scratch and (not scratch.is_absolute() or not scratch.is_dir()):
        raise ValueError('Video scratch path must be an existing absolute directory')
    scratch.mkdir(parents=True, exist_ok=True)
    output_free = shutil.disk_usage(parent).free
    scratch_free = shutil.disk_usage(scratch).free
    same_storage = parent.stat().st_dev == scratch.stat().st_dev
    output_required = estimate * (2 if same_storage else 1) + (audio_bytes if same_storage else 0)
    if output_required > output_free * 0.9:
        raise ValueError(f'Estimated video and checkpoints exceed output disk space ({output_free:,} bytes free)')
    if not same_storage and estimate + audio_bytes > scratch_free * 0.9:
        raise ValueError(f'Estimated checkpoints and soundtrack exceed scratch disk space ({scratch_free:,} bytes free)')
    created = store.create(request)
    try:
        active = store.resume(created['id'])
    except Exception:
        store.discard(created['id'])
        raise
    active.update({
        'filename': store.output_filename(created['id']),
        'estimatedBytes': estimate,
        'bitRate': bit_rate,
    })
    return active


def pause_all_videos():
    if VIDEO_STORE is not None:
        VIDEO_STORE.pause_all()


atexit.register(pause_all_videos)


def finish_video(job_id):
    return video_store().finish(job_id)


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
    # Frame uploads are sequential, so keep their HTTP/1.1 connection alive.
    # HTTP/1.0 forced Safari to create hundreds of short-lived TCP connections
    # during one export, eventually making localhost intermittently unreachable.
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if urlparse(self.path).path.startswith(('/studio/', '/api/')) or urlparse(self.path).path in ('/', '/index.html', '/tesseract.js', '/viewer-skyboxes.js', '/skybox-paths.js', '/visual-music.js', '/visual-music-core.js'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        if self.close_connection:
            self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_BODY:
            raise ValueError('JSON request must be between 1 byte and 100 MB')
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith('/studio/') or path in ('/', '/index.html', '/tesseract.js', '/viewer-skyboxes.js', '/skybox-paths.js', '/visual-music.js', '/visual-music-core.js'):
            for header in ('If-Modified-Since', 'If-None-Match'):
                if header in self.headers:
                    del self.headers[header]
        if path == '/api/video/capabilities':
            return self.send_json(200, video_capabilities())
        if path == '/api/video/jobs':
            try:
                return self.send_json(200, {'jobs': video_store(for_control=True).list_jobs()})
            except ValueError as error:
                return self.send_json(400, {'error': str(error)})
            except OSError as error:
                return self.send_json(500, {'error': str(error)})
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
        if route.path not in ('/api/export', '/api/export/start', '/api/export/face', '/api/export/finish', '/api/publish',
                              '/api/video/start', '/api/video/poster', '/api/video/audio', '/api/video/frame', '/api/video/finish', '/api/video/cancel',
                              '/api/video/pause', '/api/video/resume'):
            self.close_connection = True
            return self.send_json(404, {'error': 'Unknown endpoint'})
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            self.close_connection = True
            return self.send_json(403, {'error': 'Cross-origin writes are not allowed'})
        try:
            if route.path.startswith('/api/video/') and route.path not in ('/api/video/pause', '/api/video/cancel'):
                store = video_store()
                query = parse_qs(route.query) if route.path in ('/api/video/frame', '/api/video/poster', '/api/video/audio') else {}
                check_video_recovery(store, query.get('id', [None])[0], query.get('lease', [None])[0])
            if route.path == '/api/video/poster':
                query = parse_qs(route.query)
                job_id = query.get('id', [''])[0]
                lease = query.get('lease', [''])[0]
                store = video_store()
                job = store.get(job_id)
                length = int(self.headers.get('Content-Length', '0'))
                if not 24 <= length <= MAX_VIDEO_FRAME_BYTES:
                    raise ValueError('PNG resume frame has an invalid size')
                previous_timeout = self.connection.gettimeout()
                self.connection.settimeout(VIDEO_FRAME_READ_TIMEOUT)
                try:
                    data = self.rfile.read(length)
                except TimeoutError:
                    try:
                        store.pause(job_id, 'Resume frame upload was interrupted', lease)
                    except (OSError, ValueError):
                        pass
                    raise ValueError('Resume frame upload was interrupted')
                finally:
                    try:
                        self.connection.settimeout(previous_timeout)
                    except OSError:
                        pass
                if len(data) != length:
                    try:
                        store.pause(job_id, 'Incomplete PNG resume frame upload', lease)
                    except (OSError, ValueError):
                        pass
                    raise ValueError('Incomplete PNG resume frame upload')
                header = data[:24]
                if header[:8] != PNG_SIGNATURE or header[12:16] != b'IHDR':
                    raise ValueError('Resume frame must be a PNG image')
                width = int.from_bytes(header[16:20], 'big')
                height = int.from_bytes(header[20:24], 'big')
                request = job['request']
                if (width, height) != (request['width'], request['height']):
                    raise ValueError(f"Resume frame must be {request['width']}×{request['height']} pixels")
                return self.send_json(201, store.write_poster(job_id, data, lease))
            if route.path == '/api/video/audio':
                query = parse_qs(route.query)
                job_id = query.get('id', [''])[0]
                lease = query.get('lease', [''])[0]
                store = video_store()
                job = store.get(job_id)
                if not job['request'].get('music', {}).get('enabled'):
                    raise ValueError('This video export does not include a soundtrack')
                length = int(self.headers.get('Content-Length', '0'))
                if not 44 <= length <= MAX_AUDIO_BYTES:
                    raise ValueError('Soundtrack WAV has an invalid size')
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError('Incomplete soundtrack WAV upload')
                details = validate_wave(data, job['request'])
                return self.send_json(201, store.write_audio(job_id, data, lease, details))
            if route.path == '/api/video/frame':
                if FFMPEG_ENCODER_ERROR:
                    raise ValueError(FFMPEG_ENCODER_ERROR)
                query = parse_qs(route.query)
                job_id = query.get('id', [''])[0]
                lease = query.get('lease', [''])[0]
                store = video_store()
                job = store.get(job_id)
                frame = int(query.get('frame', ['-1'])[0])
                length = int(self.headers.get('Content-Length', '0'))
                if not 24 <= length <= MAX_VIDEO_FRAME_BYTES:
                    raise ValueError('PNG frame has an invalid size')
                # Read the body before taking the frame lock, and don't wait forever.
                # A browser that leaves mid-upload otherwise pins this thread in read(),
                # and a pipe write must not hold the lock or finish/cancel can stall.
                previous_timeout = self.connection.gettimeout()
                self.connection.settimeout(VIDEO_FRAME_READ_TIMEOUT)
                try:
                    data = self.rfile.read(length)
                except TimeoutError:
                    try:
                        store.pause(job_id, 'Frame upload was interrupted', lease)
                    except (OSError, ValueError):
                        pass
                    raise ValueError('Frame upload was interrupted')
                finally:
                    try:
                        self.connection.settimeout(previous_timeout)
                    except OSError:
                        pass
                if len(data) != length:
                    try:
                        store.pause(job_id, 'Incomplete PNG frame upload', lease)
                    except (OSError, ValueError):
                        pass
                    raise ValueError('Incomplete PNG frame upload')
                header = data[:24]
                if header[:8] != PNG_SIGNATURE or header[12:16] != b'IHDR':
                    raise ValueError('Video frame must be a PNG image')
                width = int.from_bytes(header[16:20], 'big')
                height = int.from_bytes(header[20:24], 'big')
                request = job['request']
                if (width, height) != (request['width'], request['height']):
                    raise ValueError(f"Frame must be {request['width']}×{request['height']} pixels")
                return self.send_json(201, store.write_frame(job_id, frame, data, lease))
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
            if route.path == '/api/video/start':
                return self.send_json(201, start_video(request))
            if route.path == '/api/video/finish':
                return self.send_json(201, finish_video(request.get('id')))
            if route.path == '/api/video/cancel':
                store = video_store(for_control=True)
                check_video_recovery(store, request.get('id'), request.get('lease'))
                store.discard(request.get('id'))
                return self.send_json(200, {'cancelled': True})
            if route.path == '/api/video/pause':
                store = video_store(for_control=True)
                check_video_recovery(store, request.get('id'), request.get('lease'))
                reason = request.get('reason')
                if reason is not None:
                    if not isinstance(reason, str) or len(reason) > 500:
                        raise ValueError('Video pause reason must be text under 500 characters')
                    reason = ' '.join(reason.split()) or None
                paused = store.pause(
                    request.get('id'), reason or 'Browser paused the export', request.get('lease'))
                return self.send_json(200, paused)
            if route.path == '/api/video/resume':
                return self.send_json(200, video_store().resume(
                    request.get('id'), request, encoder_error=FFMPEG_ENCODER_ERROR))
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
        except (ConnectionError, BrokenPipeError):
            return
        except (ValueError, KeyError, TypeError, StopIteration) as error:
            # Some validation failures occur before a request body is consumed.
            # Never reuse that HTTP/1.1 connection: unread bytes could otherwise
            # be parsed as the beginning of the next request.
            self.close_connection = True
            try:
                self.send_json(400, {'error': str(error)})
            except (ConnectionError, BrokenPipeError, OSError):
                return
        except OSError as error:
            self.close_connection = True
            try:
                self.send_json(500, {'error': str(error)})
            except (ConnectionError, BrokenPipeError, OSError):
                return


class StudioHTTPServer(ThreadingHTTPServer):
    def service_actions(self):
        super().service_actions()
        try:
            if VIDEO_STORE is not None:
                VIDEO_STORE.pause_stale_jobs()
        except Exception:
            pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('-p', '--port', type=int, default=8000)
    parser.add_argument('--host', '--bind', dest='host', default='localhost',
                        help='interface to listen on; use 0.0.0.0 to accept non-local connections')
    parser.add_argument('--video-mode', choices=('resumable', 'simple'), default='resumable',
                        help='simple: one-shot encoding; cancellation discards partial output')
    args = parser.parse_args()
    VIDEO_MODE = args.video_mode
    http = StudioHTTPServer((args.host, args.port), Handler)
    ffmpeg = shutil.which('ffmpeg')
    VIDEO_FFMPEG_BOOTSTRAP = str(Path(ffmpeg).resolve()) if ffmpeg else ''
    if ffmpeg:
        FFMPEG_ENCODER_ERROR = ffmpeg_encoder_error(ffmpeg)
        FFMPEG_AUDIO_ENCODER_ERROR = ffmpeg_audio_encoder_error(ffmpeg)
    if ffmpeg:
        try:
            start_video_recovery()
        except Exception:
            http.server_close()
            raise
    # Browsers only grant Web Crypto (needed for export) to localhost or HTTPS, not 0.0.0.0.
    host = 'localhost' if args.host in ('0.0.0.0', '::', '') else args.host
    print(f'Viewer: http://{host}:{args.port}/\nStudio: http://{host}:{args.port}/studio/')
    try:
        http.serve_forever()
    finally:
        if VIDEO_STORE is not None:
            try:
                VIDEO_STORE.pause_all()
            finally:
                VIDEO_STORE.release_server()
        http.server_close()
