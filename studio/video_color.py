"""Color policy for new browser exports: preserve sRGB sample values/curve.

sRGB and BT.709 share primaries, not transfer functions. swscale converts
full-range RGB to limited-range BT.709 YUV; setparams only labels the existing
sRGB curve, it does not perform a gamma conversion.
"""
COLOR_PROFILE = 'srgb-limited-v1'


def browser_video_color_args():
    return [
        '-vf', ('scale=in_range=pc:out_range=tv:out_color_matrix=bt709,'
                'format=yuv420p,setparams=range=limited:color_primaries=bt709:'
                'color_trc=iec61966-2-1:colorspace=bt709'),
        '-color_range', 'tv', '-colorspace', 'bt709',
        '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1',
    ]
