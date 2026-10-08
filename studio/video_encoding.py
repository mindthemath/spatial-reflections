"""Pinned H.264 encoding profiles shared by simple and resumable exports."""

MASTER_ENCODING = {
    'rateControl': 'crf', 'crf': 12, 'preset': 'slow', 'tune': 'grain',
    'aqMode': 3, 'aqStrength': 1.1, 'pixelFormat': 'yuv420p',
}


def h264_encoding_args(request, thread_args=()):
    """Return output-side libx264 options for a validated video request.

    Existing qualities retain their capped average-bitrate behavior. Master is
    intentionally unconstrained constant quality: dark photographic texture is
    allowed to consume the bits it needs instead of competing with bright detail.
    """
    if request.get('quality') == 'master':
        profile = {**MASTER_ENCODING, **request.get('encoding', {})}
        return [
            '-c:v', 'libx264', '-preset', str(profile['preset']), *thread_args,
            '-crf', str(profile['crf']), '-tune', str(profile['tune']),
            '-x264-params', f"aq-mode={profile['aqMode']}:aq-strength={profile['aqStrength']}",
            '-pix_fmt', str(profile['pixelFormat']),
        ]
    bit_rate = int(request['bitRate'])
    return [
        '-c:v', 'libx264', '-preset', 'medium', *thread_args,
        '-b:v', str(bit_rate), '-maxrate', str(round(bit_rate * 1.5)),
        '-bufsize', str(bit_rate * 2), '-pix_fmt', 'yuv420p',
    ]
