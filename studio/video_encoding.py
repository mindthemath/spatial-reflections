# Copyright 2026 Michael Pilosov. All rights reserved.
"""Pinned H.264 encoding profiles shared by simple and resumable exports."""

MASTER_ENCODING = {
    'rateControl': 'crf', 'crf': 12, 'preset': 'slow', 'tune': 'grain',
    'aqMode': 3, 'aqStrength': 1.1, 'pixelFormat': 'yuv420p',
}
# Master's look with a bitrate ceiling for streaming: easy footage encodes exactly
# like master, while grain-heavy footage is held to the planning rate.
CAPPED_ENCODING = {**MASTER_ENCODING, 'rateControl': 'capped-crf', 'keyint': 60}
CRF_QUALITIES = {'master': MASTER_ENCODING, 'capped': CAPPED_ENCODING}


def h264_encoding_args(request, thread_args=()):
    """Return output-side libx264 options for a validated video request.

    Existing qualities retain their capped average-bitrate behavior. Master is
    intentionally unconstrained constant quality: dark photographic texture is
    allowed to consume the bits it needs instead of competing with bright detail.
    """
    quality = request.get('quality')
    if quality in CRF_QUALITIES:
        profile = {**CRF_QUALITIES[quality], **request.get('encoding', {})}
        params = f"aq-mode={profile['aqMode']}:aq-strength={profile['aqStrength']}"
        cap = []
        if quality == 'capped':
            # Two-second keyframes keep streamed seeking responsive.
            params += f":keyint={profile['keyint']}:min-keyint={profile['keyint'] // 2}"
            bit_rate = int(request['bitRate'])
            cap = ['-maxrate', str(bit_rate), '-bufsize', str(bit_rate * 2)]
        return [
            '-c:v', 'libx264', '-preset', str(profile['preset']), *thread_args,
            '-crf', str(profile['crf']), '-tune', str(profile['tune']),
            '-x264-params', params, *cap,
            '-pix_fmt', str(profile['pixelFormat']),
        ]
    bit_rate = int(request['bitRate'])
    return [
        '-c:v', 'libx264', '-preset', 'medium', *thread_args,
        '-b:v', str(bit_rate), '-maxrate', str(round(bit_rate * 1.5)),
        '-bufsize', str(bit_rate * 2), '-pix_fmt', 'yuv420p',
    ]
