"""Validation and ffmpeg arguments for optional deterministic soundtrack WAVs."""
import struct


MUSIC_SCHEMA = 'spatial-reflections-music-v1'
AUDIO_SAMPLE_RATE = 48_000
AUDIO_CHANNELS = 2
AUDIO_SAMPLE_BYTES = 2
MAX_AUDIO_SECONDS = 900
MAX_AUDIO_BYTES = AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * AUDIO_SAMPLE_BYTES * MAX_AUDIO_SECONDS + 4096


def expected_audio_samples(request):
    return round(int(request['frames']) * AUDIO_SAMPLE_RATE / int(request['fps']))


def validate_music_request(request):
    music = request.get('music')
    if music is None:
        return None
    if not isinstance(music, dict) or set(music) - {
            'schema', 'enabled', 'sampleRate', 'channels', 'samples', 'settings', 'scoreHash'
    }:
        raise ValueError('Invalid music export settings')
    if not music.get('enabled'):
        return None
    samples = expected_audio_samples(request)
    if int(request['frames']) / int(request['fps']) > MAX_AUDIO_SECONDS:
        raise ValueError(f'Generative soundtrack exports are currently limited to {MAX_AUDIO_SECONDS // 60} minutes')
    if (music.get('schema') != MUSIC_SCHEMA
            or music.get('sampleRate') != AUDIO_SAMPLE_RATE
            or music.get('channels') != AUDIO_CHANNELS
            or music.get('samples') != samples
            or not isinstance(music.get('settings'), dict)
            or not isinstance(music.get('scoreHash'), str)
            or len(music['scoreHash']) != 64
            or any(character not in '0123456789abcdef' for character in music['scoreHash'])):
        raise ValueError('Invalid or incompatible music export settings')
    return {**music, 'enabled': True, 'samples': samples}


def validate_wave(data, request):
    """Accept only exact stereo 48 kHz signed-16 PCM for this video's duration."""
    if not isinstance(data, bytes) or not 44 <= len(data) <= MAX_AUDIO_BYTES:
        raise ValueError('Soundtrack WAV has an invalid size')
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE' or struct.unpack_from('<I', data, 4)[0] + 8 != len(data):
        raise ValueError('Soundtrack must be a complete RIFF/WAVE file')
    offset, wave_format, pcm_bytes = 12, None, None
    while offset + 8 <= len(data):
        chunk, size = data[offset:offset + 4], struct.unpack_from('<I', data, offset + 4)[0]
        start, end = offset + 8, offset + 8 + size
        if end > len(data):
            raise ValueError('Soundtrack WAV contains a truncated chunk')
        if chunk == b'fmt ':
            if size < 16:
                raise ValueError('Soundtrack WAV format is incomplete')
            wave_format = struct.unpack_from('<HHIIHH', data, start)
        elif chunk == b'data':
            if pcm_bytes is not None:
                raise ValueError('Soundtrack WAV contains multiple data chunks')
            pcm_bytes = size
        offset = end + (size & 1)
    expected_bytes = expected_audio_samples(request) * AUDIO_CHANNELS * AUDIO_SAMPLE_BYTES
    if wave_format != (1, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE,
                       AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * AUDIO_SAMPLE_BYTES,
                       AUDIO_CHANNELS * AUDIO_SAMPLE_BYTES, AUDIO_SAMPLE_BYTES * 8):
        raise ValueError('Soundtrack WAV must be stereo 48 kHz signed 16-bit PCM')
    if pcm_bytes != expected_bytes:
        raise ValueError(f'Soundtrack WAV must contain exactly {expected_audio_samples(request):,} samples')
    return {'bytes': len(data), 'samples': expected_audio_samples(request),
            'sampleRate': AUDIO_SAMPLE_RATE, 'channels': AUDIO_CHANNELS}


def mux_audio_args(audio_path, duration):
    """Arguments after the video input, preserving video while encoding AAC."""
    return [
        '-i', str(audio_path),
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', f'{duration:.9f}',
    ]
