import json
import os
import selectors
import signal
import shutil
import struct
import subprocess
import sys
import tempfile
import time
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

    def test_hard_server_crash_reaps_stopped_encoder_and_resumes_exactly(self):
        scratch = self.root / 'hard-crash-scratch'
        scratch.mkdir()
        frame_path = self.root / 'frame.png'
        frame_path.write_bytes(solid_png(64, 64, 80))
        repository = Path(__file__).resolve().parent.parent
        script = """
import json
import sys
import time
from pathlib import Path
from studio.video_resume import VideoJobStore

root, scratch, ffmpeg, frame_path = map(Path, sys.argv[1:])
store = VideoJobStore(root, ffmpeg)
job = store.create({
    'name': 'hard-crash', 'width': 64, 'height': 64, 'fps': 2, 'frames': 5,
    'quality': 'draft', 'format': 'mp4', 'bitRate': 100000,
    'checkpointSeconds': 1, 'scratchPath': str(scratch),
    'sourceUrl': '/', 'renderSignature': 'hard-crash-v1', 'viewerState': {},
})
active = store.resume(job['id'])
png = frame_path.read_bytes()
store.write_frame(job['id'], 0, png, active['lease'])
store.write_frame(job['id'], 1, png, active['lease'])
store.write_frame(job['id'], 2, png, active['lease'])
manifest = json.loads(Path(job['manifestPath']).read_text())
print(json.dumps({
    'id': job['id'], 'manifestPath': job['manifestPath'],
    'encoderPid': manifest['activeEncoder']['pid'],
}), flush=True)
time.sleep(120)
"""
        child = subprocess.Popen(
            [sys.executable, '-c', script, str(self.root), str(scratch),
             self.ffmpeg, str(frame_path)],
            cwd=repository, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        encoder_pid = None
        try:
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(15), 'crash fixture did not start its encoder')
            details = json.loads(child.stdout.readline())
            encoder_pid = details['encoderPid']

            os.kill(encoder_pid, signal.SIGSTOP)
            os.kill(child.pid, signal.SIGKILL)
            child.wait(timeout=5)

            recreated = VideoJobStore(self.root, self.ffmpeg)
            report = recreated.recover_stale_encoders()
            self.assertEqual(report, {
                'recovered': 1, 'alreadyExited': 0, 'refused': 0,
                'skippedActive': 0, 'failed': 0, 'indexFailed': False,
            })
            recovered = recreated.get(details['id'])
            self.assertEqual(recovered['nextFrame'], 2)
            self.assertEqual(recovered['state'], 'paused')

            for _ in range(50):
                try:
                    os.kill(encoder_pid, 0)
                except ProcessLookupError:
                    encoder_pid = None
                    break
                time.sleep(0.02)
            else:
                self.fail('startup recovery left the stopped ffmpeg process alive')

            resumed = recreated.resume(details['id'])
            png = frame_path.read_bytes()
            for frame in range(2, 5):
                recreated.write_frame(details['id'], frame, png, resumed['lease'])
            completed = recreated.finish(details['id'])
            stream, media_format = self.probe(self.root / 'videos' / completed['filename'])
            self.assertEqual(int(stream['nb_read_frames']), 5)
            self.assertAlmostEqual(float(media_format['duration']), 2.5, delta=0.15)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            child.stdout.close()
            if encoder_pid is not None:
                try:
                    command = VideoJobStore(self.root, self.ffmpeg).process_command(encoder_pid)
                    if command.startswith(self.ffmpeg + ' '):
                        os.kill(encoder_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_sixty_checkpoint_soak_finalizes_without_process_leaks(self):
        # Sixty checkpoints exercise the same manifest/concat topology as a
        # one-hour export using the default 60-second checkpoint interval.
        scratch = self.root / 'soak-scratch'
        scratch.mkdir()
        store = VideoJobStore(self.root, self.ffmpeg)
        created = store.create({
            **self.request('mp4', scratch),
            'name': 'sixty-checkpoint-soak',
            'fps': 2,
            'frames': 120,
            'checkpointSeconds': 1,
        })
        active = store.resume(created['id'])
        png = solid_png(64, 64, 100)
        checkpoints = 0
        for frame in range(120):
            progress = store.write_frame(created['id'], frame, png, active['lease'])
            checkpoints += int(progress['checkpointed'])
        self.assertEqual(checkpoints, 60)

        completed = store.finish(created['id'])
        output = self.root / 'videos' / completed['filename']
        stream, media_format = self.probe(output)
        self.assertEqual(int(stream['nb_read_frames']), 120)
        self.assertAlmostEqual(float(media_format['duration']), 60.0, delta=0.15)
        self.assertEqual(store.processes_for_path(self.root), [])


if __name__ == '__main__':
    unittest.main()
