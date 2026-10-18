# Copyright 2026 Michael Pilosov. All rights reserved.
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_diff  # noqa: E402

FFMPEG = shutil.which('ffmpeg')


def tone(path, volume):
    subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                    f'sine=frequency=440:sample_rate=48000:duration=1,volume={volume}',
                    '-ac', '2', '-c:a', 'pcm_s16le', str(path)], check=True)


@unittest.skipUnless(FFMPEG, 'requires ffmpeg')
class AudioDiffTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def run_diff(self, a, b, *extra):
        with mock.patch('sys.stdout'):
            audio_diff.main([str(a), str(b), *extra])

    def test_identical_inputs_cancel_to_silence(self):
        tone(self.dir / 'a.wav', 0.5)
        shutil.copy(self.dir / 'a.wav', self.dir / 'b.wav')
        self.run_diff(self.dir / 'a.wav', self.dir / 'b.wav')
        self.assertIsNone(audio_diff.rms_dbfs(self.dir / 'a-minus-b.wav'))

    def test_difference_is_exactly_what_changed(self):
        tone(self.dir / 'loud.wav', 0.5)
        tone(self.dir / 'quiet.wav', 0.25)
        output = self.dir / 'diff.wav'
        self.run_diff(self.dir / 'loud.wav', self.dir / 'quiet.wav', '-o', str(output))
        # 0.5 - 0.25 leaves the same tone at 0.25: identical to the quiet input's level.
        self.assertAlmostEqual(audio_diff.rms_dbfs(output), audio_diff.rms_dbfs(self.dir / 'quiet.wav'), delta=0.2)
        self.run_diff(self.dir / 'loud.wav', self.dir / 'quiet.wav', '-o', str(output), '--gain', '6')
        self.assertAlmostEqual(audio_diff.rms_dbfs(output), audio_diff.rms_dbfs(self.dir / 'loud.wav'), delta=0.2)


if __name__ == '__main__':
    unittest.main()
