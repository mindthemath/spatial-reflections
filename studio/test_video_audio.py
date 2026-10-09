# Copyright 2026 Michael Pilosov. All rights reserved.
import io
import unittest
import wave

from studio.video_audio import (
    AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, MAX_AUDIO_SECONDS, MUSIC_SCHEMA,
    expected_audio_samples, validate_music_request, validate_wave,
)


def soundtrack_wave(frames=24, fps=24):
    samples = round(frames * AUDIO_SAMPLE_RATE / fps)
    output = io.BytesIO()
    with wave.open(output, 'wb') as stream:
        stream.setnchannels(AUDIO_CHANNELS)
        stream.setsampwidth(2)
        stream.setframerate(AUDIO_SAMPLE_RATE)
        stream.writeframes(bytes(samples * AUDIO_CHANNELS * 2))
    return output.getvalue()


def music_request(frames=24, fps=24):
    samples = round(frames * AUDIO_SAMPLE_RATE / fps)
    return {
        'frames': frames, 'fps': fps,
        'music': {
            'schema': MUSIC_SCHEMA, 'enabled': True,
            'sampleRate': AUDIO_SAMPLE_RATE, 'channels': AUDIO_CHANNELS,
            'samples': samples, 'settings': {'preset': 'abyssdrive'},
            'scoreHash': 'a' * 64,
        },
    }


class VideoAudioValidationTest(unittest.TestCase):
    def test_exact_pcm_wave_and_music_metadata(self):
        request = music_request(frames=17, fps=24)
        music = validate_music_request(request)
        self.assertEqual(music['samples'], expected_audio_samples(request))
        details = validate_wave(soundtrack_wave(17, 24), request)
        self.assertEqual(details['samples'], expected_audio_samples(request))
        self.assertEqual(details['sampleRate'], 48000)
        self.assertEqual(details['channels'], 2)

    def test_wave_rejects_wrong_duration_format_and_truncation(self):
        request = music_request()
        with self.assertRaisesRegex(ValueError, 'exactly'):
            validate_wave(soundtrack_wave(23, 24), request)
        mono = bytearray(soundtrack_wave())
        mono[22:24] = (1).to_bytes(2, 'little')
        with self.assertRaisesRegex(ValueError, 'stereo'):
            validate_wave(bytes(mono), request)
        with self.assertRaisesRegex(ValueError, 'complete'):
            validate_wave(soundtrack_wave()[:-4], request)

    def test_music_request_is_versioned_bounded_and_strict(self):
        request = music_request()
        request['music']['unexpected'] = True
        with self.assertRaisesRegex(ValueError, 'Invalid music'):
            validate_music_request(request)
        too_long = music_request((MAX_AUDIO_SECONDS + 1) * 24, 24)
        with self.assertRaisesRegex(ValueError, 'limited'):
            validate_music_request(too_long)
        disabled = music_request()
        disabled['music'] = {'enabled': False}
        self.assertIsNone(validate_music_request(disabled))


if __name__ == '__main__':
    unittest.main()
