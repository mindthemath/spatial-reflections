# Copyright 2026 Michael Pilosov. All rights reserved.
"""Embed or verify the artwork copyright notice in published image metadata.

JPEGs get an EXIF APP1 segment (Copyright and Artist); PNGs get tEXt chunks.
Only metadata is rewritten: compressed image data is copied byte for byte.
"""

from __future__ import annotations

import argparse
import re
import struct
import subprocess
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DISTRIBUTION_RIGHTS_FILE = ROOT / 'DISTRIBUTION_RIGHTS.txt'
# Published artwork only; site/icons/ are third-party public-domain images.
DEFAULT_PREFIXES = ('site/assets/', 'site/work/')
JPEG_SUFFIXES = {'.jpg', '.jpeg'}
PNG_SUFFIXES = {'.png'}
NOTICE = re.compile(r'^Copyright\s+\d{4}(?:-\d{4})?\s+(?P<owner>.+?)\.\s')
EXIF_HEADER = b'Exif\x00\x00'
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
TAG_ARTIST, TAG_COPYRIGHT = 0x013B, 0x8298


def copyright_fields() -> tuple[str, str]:
    lines = DISTRIBUTION_RIGHTS_FILE.read_text(encoding='utf-8').splitlines()
    match = NOTICE.match(lines[0]) if lines else None
    if not match:
        raise ValueError('DISTRIBUTION_RIGHTS.txt must begin with "Copyright <year> <owner>. ..."')
    return lines[0], match['owner']


def exif_segment(notice: str, artist: str) -> bytes:
    """A minimal big-endian TIFF IFD0 holding Artist and Copyright (ASCII)."""
    entries = sorted([(TAG_ARTIST, artist.encode('ascii') + b'\0'),
                      (TAG_COPYRIGHT, notice.encode('ascii') + b'\0')])
    offset = 8 + 2 + 12 * len(entries) + 4
    ifd, data = struct.pack('>H', len(entries)), b''
    for tag, value in entries:
        # Every value here exceeds 4 bytes, so it lives after the IFD.
        ifd += struct.pack('>HHII', tag, 2, len(value), offset + len(data))
        data += value
    tiff = b'MM\x00\x2a' + struct.pack('>I', 8) + ifd + struct.pack('>I', 0) + data
    payload = EXIF_HEADER + tiff
    return b'\xff\xe1' + struct.pack('>H', len(payload) + 2) + payload


def jpeg_segments(data: bytes) -> tuple[list[bytes], bytes]:
    """Split a JPEG into its header segments and the remainder from SOS onward."""
    if not data.startswith(b'\xff\xd8'):
        raise ValueError('not a JPEG')
    segments, index = [], 2
    while index < len(data):
        if data[index] != 0xFF:
            raise ValueError('malformed JPEG marker')
        marker = data[index + 1]
        if marker == 0xFF:  # fill byte
            index += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:
            segments.append(data[index:index + 2])
            index += 2
            continue
        if marker == 0xDA:
            return segments, data[index:]
        length = struct.unpack('>H', data[index + 2:index + 4])[0]
        segments.append(data[index:index + 2 + length])
        index += 2 + length
    raise ValueError('JPEG has no image data')


def stamped_jpeg(data: bytes, notice: str, artist: str) -> bytes:
    segments, scan = jpeg_segments(data)
    kept = [s for s in segments if not (s[:2] == b'\xff\xe1' and s[4:10] == EXIF_HEADER)]
    # EXIF follows a JFIF APP0 when one is present, otherwise SOI directly.
    position = 1 if kept and kept[0][:2] == b'\xff\xe0' else 0
    kept.insert(position, exif_segment(notice, artist))
    return b'\xff\xd8' + b''.join(kept) + scan


def png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))


def stamped_png(data: bytes, notice: str, artist: str) -> bytes:
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError('not a PNG')
    keywords = {b'Copyright': notice, b'Author': artist}
    chunks, index = [], len(PNG_SIGNATURE)
    while index < len(data):
        length = struct.unpack('>I', data[index:index + 4])[0]
        kind = data[index + 4:index + 8]
        chunk = data[index:index + 12 + length]
        index += 12 + length
        if kind == b'tEXt' and chunk[8:8 + length].split(b'\0', 1)[0] in keywords:
            continue
        chunks.append((kind, chunk))
    # Place text right after IHDR, before any image data.
    text = [png_chunk(b'tEXt', key + b'\0' + value.encode('latin-1')) for key, value in keywords.items()]
    return PNG_SIGNATURE + chunks[0][1] + b''.join(text) + b''.join(chunk for _, chunk in chunks[1:])


def stamped(path: Path, notice: str, artist: str) -> bytes:
    data = path.read_bytes()
    if path.suffix.lower() in JPEG_SUFFIXES:
        return stamped_jpeg(data, notice, artist)
    return stamped_png(data, notice, artist)


def default_paths() -> list[Path]:
    completed = subprocess.run(['git', 'ls-files', '-z', *DEFAULT_PREFIXES], cwd=ROOT,
                               check=True, capture_output=True)
    names = sorted(value.decode() for value in completed.stdout.split(b'\0') if value)
    return [ROOT / name for name in names if Path(name).suffix.lower() in JPEG_SUFFIXES | PNG_SUFFIXES]


def expand(arguments: list[str]) -> list[Path]:
    paths = []
    for argument in arguments:
        path = Path(argument).resolve()
        if path.is_dir():
            paths += sorted(p for p in path.rglob('*') if p.suffix.lower() in JPEG_SUFFIXES | PNG_SUFFIXES)
        elif path.suffix.lower() in JPEG_SUFFIXES | PNG_SUFFIXES:
            paths.append(path)
        else:
            raise ValueError(f'not a JPEG or PNG: {argument}')
    return paths


def display(path: Path) -> str:
    return path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else str(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('paths', nargs='*', help='images or folders (default: tracked images under site/assets/ and site/work/)')
    parser.add_argument('--check', action='store_true', help='report images missing the notice without writing')
    args = parser.parse_args()
    notice, artist = copyright_fields()
    paths = expand(args.paths) if args.paths else default_paths()
    changed = []
    for path in paths:
        updated = stamped(path, notice, artist)
        if updated == path.read_bytes():
            continue
        changed.append(display(path))
        if not args.check:
            path.write_bytes(updated)
    if args.check and changed:
        print('Images missing the copyright notice:')
        print('\n'.join(f'  {path}' for path in changed))
        return 1
    if args.check:
        print(f'Verified copyright metadata in {len(paths)} images.')
    else:
        print(f'Stamped copyright metadata into {len(changed)} of {len(paths)} images.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
