# Copyright 2026 Michael Pilosov. All rights reserved.
"""Write the difference between two soundtracks: A minus B, sample by sample.

Silence means the soundtracks are identical; anything audible is exactly what
changed between them. Both inputs are resampled to 48 kHz stereo, aligned at
their start and trimmed to the shorter one. The result is 32-bit float WAV so
the difference can never clip. Requires ffmpeg on PATH.

    python3 scripts/audio_diff.py grain.mp4 nograin.mp4
    python3 scripts/audio_diff.py a.mp4 b.mp4 -o diff.wav --gain 18
"""

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path


def default_output(a, b):
    return a.with_name(f'{a.stem}-minus-{b.stem}.wav')


def filter_graph(gain_db):
    prepare = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo'
    return (f'[0:a:0]{prepare}[a];[1:a:0]{prepare}[b];'
            f'[a][b]amerge=inputs=2,pan=stereo|c0=c0-c2|c1=c1-c3,volume={gain_db}dB[d]')


def rms_dbfs(path, ffmpeg='ffmpeg'):
    """Overall RMS level of a file's audio, in dBFS (None if silent or unmeasurable)."""
    result = subprocess.run([ffmpeg, '-hide_banner', '-nostats', '-i', str(path), '-map', '0:a:0',
                             '-af', 'astats=measure_perchannel=none', '-f', 'null', '-'],
                            capture_output=True, text=True)
    match = re.search(r'RMS level dB:\s*(-?[\d.]+|-inf)', result.stderr)
    if not match or match.group(1) == '-inf':
        return None
    return float(match.group(1))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('a', type=Path, help='first file (any audio or video ffmpeg can read)')
    parser.add_argument('b', type=Path, help='second file, subtracted from the first')
    parser.add_argument('-o', '--output', type=Path, help='output WAV (default: <a>-minus-<b>.wav beside a)')
    parser.add_argument('--gain', type=float, default=0.0,
                        help='boost the difference by this many dB to make quiet changes audible (default 0)')
    args = parser.parse_args(argv)
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        parser.error('ffmpeg is required on PATH')
    for path in (args.a, args.b):
        if not path.is_file():
            parser.error(f'not a file: {path}')
    output = args.output or default_output(args.a, args.b)
    command = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', str(args.a), '-i', str(args.b),
               '-filter_complex', filter_graph(args.gain), '-map', '[d]', '-c:a', 'pcm_f32le', str(output)]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        sys.exit(f'ffmpeg failed:\n{result.stderr.strip()}')
    levels = {name: rms_dbfs(path, ffmpeg) for name, path in (('A', args.a), ('B', args.b), ('A-B', output))}
    describe = lambda level: 'silent' if level is None else f'{level:.1f} dBFS'
    print(f'Wrote {output}')
    print(f'RMS  A {describe(levels["A"])} · B {describe(levels["B"])} · difference {describe(levels["A-B"])}'
          + (f' (includes +{args.gain:g} dB gain)' if args.gain else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
