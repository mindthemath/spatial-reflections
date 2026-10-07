"""Bounded real encoder checks for the independent one-shot backend."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from studio.video_simple import SimpleVideoBackend
from studio.test_video_resume_integration import solid_png


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'ffmpeg/ffprobe required')
class SimpleVideoIntegrationTest(unittest.TestCase):
    def test_mp4_and_mkv_have_exact_frames_duration_and_bt709(self):
        for container in ('mp4','mkv'):
            with self.subTest(container=container), tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                backend=SimpleVideoBackend(root,shutil.which('ffmpeg'))
                try:
                    job=backend.start({'name':'simple-real','width':64,'height':64,'fps':24,
                                       'frames':3,'format':container,'quality':'draft','bitRate':100000})
                    poster=solid_png(64,64,0)
                    backend.write_poster(job['id'],poster,job['lease'])
                    for frame in range(3):backend.write_frame(job['id'],frame,solid_png(64,64,frame*60),job['lease'])
                    result=backend.finish(job['id']);path=root/result['url'].lstrip('/')
                    self.assertEqual(path.with_suffix('.png').read_bytes(),poster)
                    metadata=json.loads(path.with_suffix('.json').read_text())
                    self.assertEqual(metadata['poster']['file'],path.with_suffix('.png').name)
                    self.assertEqual(metadata['frames'],3);self.assertEqual(metadata['fps'],24)
                    probe=subprocess.run([shutil.which('ffprobe'),'-v','error','-count_frames',
                        '-select_streams','v:0','-show_entries',
                        'stream=nb_read_frames,color_range,color_space,color_transfer,color_primaries:format=duration',
                        '-of','json',str(path)],capture_output=True,text=True,check=True,timeout=10)
                    info=json.loads(probe.stdout);stream=info['streams'][0]
                    self.assertEqual(int(stream['nb_read_frames']),3)
                    # Decode all frames back to full-range RGB: gamma tags must
                    # not hide an unintended change to source sample values.
                    decoded=subprocess.run([shutil.which('ffmpeg'),'-v','error','-threads','1',
                        '-filter_threads','1','-i',str(path),'-frames:v','3',
                        '-vf','scale=in_range=tv:out_range=pc:in_color_matrix=bt709',
                        '-pix_fmt','rgb24','-f','rawvideo','pipe:1'],
                        capture_output=True,check=True,timeout=10).stdout
                    self.assertEqual(len(decoded),3*64*64*3)
                    for frame in range(3):
                        pixels=decoded[frame*64*64*3:(frame+1)*64*64*3]
                        expected=(frame*60,64,255-frame*60)
                        for channel,value in enumerate(expected):
                            average=sum(pixels[channel::3])/(64*64)
                            self.assertLess(abs(average-value),3, (container,frame,channel,average,value))
                    self.assertAlmostEqual(float(info['format']['duration']),3/24,delta=.05)
                    self.assertEqual(stream['color_range'],'tv')
                    for key in ('color_space','color_primaries'):self.assertEqual(stream[key],'bt709')
                    self.assertEqual(stream['color_transfer'],'iec61966-2-1')
                    self.assertFalse((root/'videos'/'.checkpoints').exists())
                    self.assertFalse(list((root/'videos').glob('.simple-*')))
                finally:backend.pause_all();backend.release_server()

    def test_cancel_real_encoder_leaves_no_partial_or_running_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            backend=SimpleVideoBackend(temporary,shutil.which('ffmpeg'))
            try:
                job=backend.start({'name':'cancel-real','width':64,'height':64,'fps':24,
                                   'frames':24,'format':'mp4','bitRate':100000})
                backend.write_frame(job['id'],0,solid_png(64,64,100),job['lease'])
                process=backend.jobs[job['id']]['process'];backend.discard(job['id'])
                self.assertIsNotNone(process.poll())
                self.assertFalse(list((Path(temporary)/'videos').glob('.simple-*')))
                self.assertFalse(list((Path(temporary)/'videos').glob('*.mp4')))
            finally:backend.pause_all();backend.release_server()
