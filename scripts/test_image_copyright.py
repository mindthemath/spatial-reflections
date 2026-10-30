# Copyright 2026 Michael Pilosov. All rights reserved.
import hashlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import image_copyright  # noqa: E402

FFMPEG = shutil.which('ffmpeg')
NOTICE, ARTIST = 'Copyright 2026 Test Owner. All rights reserved.', 'Test Owner'


def pixels(path):
    raw = subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-i', str(path),
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], check=True, capture_output=True).stdout
    return hashlib.sha256(raw).hexdigest()


@unittest.skipUnless(FFMPEG, 'requires ffmpeg')
class ImageCopyrightTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def image(self, name):
        path = self.dir / name
        subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
                        'testsrc=size=64x64', '-frames:v', '1', str(path)], check=True)
        return path

    def test_notice_comes_from_distribution_rights(self):
        notice, artist = image_copyright.copyright_fields()
        self.assertTrue(notice.startswith('Copyright '))
        self.assertIn(artist, notice)

    def test_jpeg_gains_exif_without_touching_image_data(self):
        path = self.image('face.jpg')
        original, before = path.read_bytes(), pixels(path)
        stamped = image_copyright.stamped_jpeg(original, NOTICE, ARTIST)
        self.assertEqual(image_copyright.jpeg_segments(stamped)[1], image_copyright.jpeg_segments(original)[1])
        self.assertIn(NOTICE.encode() + b'\0', stamped)
        self.assertIn(ARTIST.encode() + b'\0', stamped)
        path.write_bytes(stamped)
        self.assertEqual(pixels(path), before)
        # Re-stamping is idempotent and replaces, rather than stacks, the EXIF segment.
        self.assertEqual(image_copyright.stamped_jpeg(stamped, NOTICE, ARTIST), stamped)
        restamped = image_copyright.stamped_jpeg(stamped, 'Copyright 2027 Other. All rights reserved.', 'Other')
        exif = [s for s in image_copyright.jpeg_segments(restamped)[0] if s[4:10] == image_copyright.EXIF_HEADER]
        self.assertEqual(len(exif), 1)
        self.assertNotIn(NOTICE.encode(), restamped)

    def test_png_gains_text_chunks_and_still_decodes(self):
        path = self.image('face.png')
        before = pixels(path)
        stamped = image_copyright.stamped_png(path.read_bytes(), NOTICE, ARTIST)
        self.assertIn(b'tEXtCopyright\0' + NOTICE.encode(), stamped)
        self.assertIn(b'tEXtAuthor\0' + ARTIST.encode(), stamped)
        path.write_bytes(stamped)
        self.assertEqual(pixels(path), before)
        self.assertEqual(image_copyright.stamped_png(stamped, NOTICE, ARTIST), stamped)


if __name__ == '__main__':
    unittest.main()
