# Copyright 2026 Michael Pilosov. All rights reserved.
"""Apply or verify the repository's canonical copyright header."""

from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_RIGHTS_FILE = ROOT / 'SOURCE_RIGHTS.txt'
EXCLUDED_PREFIXES = ('vendor/', 'node_modules/', 'exports/', 'videos/', 'raw/', 'site/work/', 'docs/')
HASH_NAMES = {'Dockerfile', 'makefile'}
HASH_SUFFIXES = {'.py', '.sh', '.yml', '.yaml'}
BLOCK_SUFFIXES = {'.js', '.mjs', '.cjs', '.css'}
HTML_SUFFIXES = {'.html'}
SUPPORTED_SUFFIXES = HASH_SUFFIXES | BLOCK_SUFFIXES | HTML_SUFFIXES
GENERATED_NOTICE = re.compile(
    r'^(?:#|/\*|<!--)\s*Copyright\s+\d{4}(?:-\d{4})?\s+.+?\s*(?:\*/|-->)?$'
)


def copyright_text() -> str:
    lines = SOURCE_RIGHTS_FILE.read_text(encoding='utf-8').splitlines()
    if not lines or not lines[0].startswith('Copyright '):
        raise ValueError('SOURCE_RIGHTS.txt must begin with the canonical Copyright line')
    return lines[0]


def source_paths() -> list[Path]:
    completed = subprocess.run(
        ['git', 'ls-files', '-z'], cwd=ROOT, check=True, capture_output=True
    )
    relative_paths = {Path(value.decode()) for value in completed.stdout.split(b'\0') if value}
    # Include this script on its first run, before it has necessarily been staged.
    relative_paths.add(Path(__file__).resolve().relative_to(ROOT))
    paths = []
    for relative in sorted(relative_paths, key=lambda value: value.as_posix()):
        name = relative.as_posix()
        if name.startswith(EXCLUDED_PREFIXES):
            continue
        if relative.name not in HASH_NAMES and relative.suffix not in SUPPORTED_SUFFIXES:
            continue
        path = ROOT / relative
        if path.is_file():
            paths.append(path)
    return paths


def header_for(path: Path, notice: str) -> str:
    if path.suffix in BLOCK_SUFFIXES:
        return f'/* {notice} */'
    if path.suffix in HTML_SUFFIXES:
        return f'<!-- {notice} -->'
    return f'# {notice}'


def insertion_index(path: Path, lines: list[str]) -> int:
    if lines and lines[0].startswith('#!'):
        return 1
    if path.suffix in HTML_SUFFIXES and lines and re.match(r'<!doctype\s+html>', lines[0], re.I):
        return 1
    return 0


def updated_text(path: Path, notice: str) -> tuple[str, bool]:
    original = path.read_text(encoding='utf-8')
    lines = original.splitlines()
    index = insertion_index(path, lines)
    expected = header_for(path, notice)
    if index < len(lines) and GENERATED_NOTICE.fullmatch(lines[index].strip()):
        lines[index] = expected
    else:
        lines.insert(index, expected)
    updated = '\n'.join(lines) + ('\n' if original.endswith(('\n', '\r')) or not original else '')
    return updated, updated != original


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='report stale or missing headers without writing')
    args = parser.parse_args()
    notice = copyright_text()
    changed = []
    for path in source_paths():
        updated, differs = updated_text(path, notice)
        if not differs:
            continue
        changed.append(path.relative_to(ROOT).as_posix())
        if not args.check:
            path.write_text(updated, encoding='utf-8')
    if args.check and changed:
        print('Missing or stale copyright headers:')
        print('\n'.join(f'  {path}' for path in changed))
        return 1
    action = 'Verified' if args.check else 'Updated'
    print(f'{action} copyright headers in {len(source_paths())} source files.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
