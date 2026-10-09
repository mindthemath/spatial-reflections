# Copyright 2026 Michael Pilosov. All rights reserved.
import unittest

from studio.video_encoding import MASTER_ENCODING, h264_encoding_args


class VideoEncodingProfileTest(unittest.TestCase):
    def test_existing_quality_keeps_capped_average_bitrate(self):
        command = h264_encoding_args({'quality': 'high', 'bitRate': 7_464_960}, ['-threads', '2'])
        self.assertEqual(command[command.index('-preset') + 1], 'medium')
        self.assertEqual(command[command.index('-b:v') + 1], '7464960')
        self.assertEqual(command[command.index('-maxrate') + 1], str(round(7_464_960 * 1.5)))
        self.assertEqual(command[command.index('-bufsize') + 1], str(7_464_960 * 2))
        self.assertNotIn('-crf', command)

    def test_master_is_unconstrained_dark_detail_constant_quality(self):
        request = {'quality': 'master', 'bitRate': 99, 'encoding': dict(MASTER_ENCODING)}
        command = h264_encoding_args(request, ['-threads', '2'])
        self.assertEqual(command[command.index('-preset') + 1], 'slow')
        self.assertEqual(command[command.index('-crf') + 1], '12')
        self.assertEqual(command[command.index('-tune') + 1], 'grain')
        self.assertEqual(command[command.index('-x264-params') + 1], 'aq-mode=3:aq-strength=1.1')
        self.assertEqual(command[command.index('-pix_fmt') + 1], 'yuv420p')
        self.assertNotIn('-b:v', command)
        self.assertNotIn('-maxrate', command)
        self.assertNotIn('-bufsize', command)
        self.assertGreater(command.index('-threads'), command.index('-c:v'))

    def test_persisted_master_profile_pins_resumed_segments(self):
        request = {'quality': 'master', 'bitRate': 99, 'encoding': {
            **MASTER_ENCODING, 'crf': 13, 'aqStrength': 1.25,
        }}
        command = h264_encoding_args(request)
        self.assertEqual(command[command.index('-crf') + 1], '13')
        self.assertEqual(command[command.index('-x264-params') + 1], 'aq-mode=3:aq-strength=1.25')


if __name__ == '__main__':
    unittest.main()
