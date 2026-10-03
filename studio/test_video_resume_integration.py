import json
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path

from studio.video_resume import VideoJobStore


def solid_png(width, height, shade):
    row = b'\x00' + bytes((shade, 64, 255 - shade)) * width
    pixels = row * height

    def chunk(name, data):
        return (
            struct.pack('>I', len(data))
            + name
            + data
            + struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
        )

    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(pixels))
        + chunk(b'IEND', b'')
    )


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),
                     'real ffmpeg and ffprobe are required')
class VideoResumeIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.ffmpeg = shutil.which('ffmpeg')
        self.ffprobe = shutil.which('ffprobe')

    def tearDown(self):
        self.temp.cleanup()

    def request(self, video_format, scratch):
        return {
            'name': f'interrupted-{video_format}',
            'width': 64,
            'height': 64,
            'fps': 2,
            'frames': 5,
            'quality': 'draft',
            'format': video_format,
            'bitRate': 100_000,
            'checkpointSeconds': 1,
            'scratchPath': str(scratch),
            'sourceUrl': '/?skybox=exports%2Ftest',
            'renderSignature': 'integration-v1',
            'viewerState': {},
        }

    def probe(self, path):
        result = subprocess.run([
            self.ffprobe, '-v', 'error', '-count_frames',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=nb_read_frames:format=duration',
            '-of', 'json', str(path),
        ], check=True, capture_output=True, text=True)
        value = json.loads(result.stdout)
        return value['streams'][0], value['format']

    def test_real_encoder_resumes_after_interruption_and_scratch_remount(self):
        for video_format in ('mp4', 'mkv'):
            with self.subTest(video_format=video_format):
                scratch = self.root / f'scratch-{video_format}'
                scratch.mkdir()
                store = VideoJobStore(self.root, self.ffmpeg)
                created = store.create(self.request(video_format, scratch))
                lease = store.resume(created['id'])['lease']

                # The first two frames form a durable checkpoint. Frame 2 belongs
                # to an incomplete segment and is intentionally lost on pause.
                store.write_frame(created['id'], 0, solid_png(64, 64, 20), lease)
                checkpoint = store.write_frame(created['id'], 1, solid_png(64, 64, 40), lease)
                self.assertEqual(checkpoint['durableFrame'], 2)
                store.write_frame(created['id'], 2, solid_png(64, 64, 60), lease)
                paused = store.pause(created['id'], 'simulated browser interruption', lease)
                self.assertEqual(paused['nextFrame'], 2)

                # Simulate a temporarily disconnected mounted share.
                detached = self.root / f'detached-{video_format}'
                scratch.rename(detached)
                unavailable = VideoJobStore(self.root, self.ffmpeg).list_jobs()[0]
                self.assertEqual(unavailable['state'], 'unavailable')
                scratch.parent.mkdir(parents=True, exist_ok=True)
                detached.rename(scratch)

                recreated = VideoJobStore(self.root, self.ffmpeg)
                resumed = recreated.resume(created['id'])
                self.assertEqual(resumed['nextFrame'], 2)
                for frame in range(2, 5):
                    recreated.write_frame(
                        created['id'], frame, solid_png(64, 64, 20 + frame * 20),
                        resumed['lease'])

                completed = recreated.finish(created['id'])
                output = self.root / 'videos' / completed['filename']
                stream, media_format = self.probe(output)
                self.assertEqual(int(stream['nb_read_frames']), 5)
                self.assertAlmostEqual(float(media_format['duration']), 2.5, delta=0.15)
                self.assertTrue(output.with_suffix('.json').is_file())
                self.assertEqual(recreated.list_jobs(), [])


if __name__ == '__main__':
    unittest.main()
