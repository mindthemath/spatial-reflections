"""Real ffmpeg checks for optional soundtrack muxing and resume persistence."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import wave

from studio.test_video_resume_integration import solid_png
from studio.video_audio import MUSIC_SCHEMA, validate_wave
from studio.video_resume import VideoJobStore
from studio.video_simple import SimpleVideoBackend


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
class VideoAudioIntegrationTest(unittest.TestCase):
    def request(self, video_format):
        frames, fps = 12, 6
        return {
            'name': 'soundtrack', 'width': 64, 'height': 64,
            'fps': fps, 'frames': frames, 'format': video_format,
            'quality': 'draft', 'bitRate': 100_000, 'checkpointSeconds': 1,
            'sourceUrl': '/', 'renderSignature': 'music-render-v1', 'viewerState': {},
            'music': {
                'schema': MUSIC_SCHEMA, 'enabled': True, 'sampleRate': 48_000,
                'channels': 2, 'samples': round(frames * 48_000 / fps),
                'settings': {'preset': 'abyssdrive'}, 'scoreHash': 'b' * 64,
            },
        }

    @staticmethod
    def wave(request):
        output = io.BytesIO()
        samples = request['music']['samples']
        with wave.open(output, 'wb') as stream:
            stream.setnchannels(2); stream.setsampwidth(2); stream.setframerate(48_000)
            pcm = bytearray()
            for sample in range(samples):
                value = round(5000 * ((sample % 800) / 800 - .5))
                pcm += int(value).to_bytes(2, 'little', signed=True) * 2
            stream.writeframes(pcm)
        return output.getvalue()

    def assert_output(self, path, request, wave_bytes):
        probe = subprocess.run([
            shutil.which('ffprobe'), '-v', 'error',
            '-show_entries', 'stream=codec_type,codec_name,duration:format=duration',
            '-of', 'json', str(path),
        ], capture_output=True, text=True, check=True, timeout=15)
        info = json.loads(probe.stdout)
        self.assertEqual([(item['codec_type'], item['codec_name']) for item in info['streams']],
                         [('video', 'h264'), ('audio', 'aac')])
        self.assertAlmostEqual(float(info['format']['duration']), 2, delta=.08)
        metadata = json.loads(path.with_suffix('.json').read_text())
        self.assertEqual(metadata['music']['scoreHash'], 'b' * 64)
        self.assertEqual(metadata['audio']['sha256'], hashlib.sha256(wave_bytes).hexdigest())
        self.assertNotIn('file', metadata['audio'])

    def test_simple_and_resumable_mp4_and_mkv_include_exact_soundtrack(self):
        for backend_name in ('simple', 'resumable'):
            for video_format in ('mp4', 'mkv'):
                with self.subTest(backend=backend_name, format=video_format), tempfile.TemporaryDirectory() as temporary:
                    request = self.request(video_format)
                    wave_bytes = self.wave(request)
                    details = validate_wave(wave_bytes, request)
                    if backend_name == 'simple':
                        backend = SimpleVideoBackend(temporary, shutil.which('ffmpeg'))
                        active = backend.start(request)
                    else:
                        backend = VideoJobStore(temporary, shutil.which('ffmpeg'))
                        created = backend.create(request)
                        active = backend.resume(created['id'])
                    backend.write_audio(active['id'], wave_bytes, active['lease'], details)
                    for frame in range(6):
                        backend.write_frame(active['id'], frame, solid_png(64, 64, 20 + frame * 8), active['lease'])
                    if backend_name == 'resumable':
                        paused = backend.pause(active['id'], 'soundtrack resume fixture', active['lease'])
                        self.assertEqual(paused['nextFrame'], 6)
                        backend = VideoJobStore(temporary, shutil.which('ffmpeg'))
                        active = backend.resume(active['id'])
                    for frame in range(6, 12):
                        backend.write_frame(active['id'], frame, solid_png(64, 64, 20 + frame * 8), active['lease'])
                    completed = backend.finish(active['id'])
                    path = Path(temporary) / completed['url'].lstrip('/')
                    self.assert_output(path, request, wave_bytes)
                    backend.release_server()


if __name__ == '__main__':
    unittest.main()
