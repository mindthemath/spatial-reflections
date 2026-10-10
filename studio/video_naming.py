# Copyright 2026 Michael Pilosov. All rights reserved.
"""Deterministic export names: identical render settings give identical hashes.

The suffix of `<label>-<UTC timestamp>-<hash>.<ext>` hashes only what determines
the rendered video and soundtrack, so re-exporting from a dropped PNG or JSON
reproduces the same hash when (and only when) the settings truly match.
"""

import hashlib
import json

# Request fields that change the output. Excluded on purpose: the export name,
# checkpoint/scratch options, UI-only viewer state, size estimates, and the page
# URL (the environment identity in the render signature hashes the skybox itself).
OUTPUT_FIELDS = ('width', 'height', 'fps', 'frames', 'startFrame', 'timeStep', 'loopFrameCount',
                 'quality', 'format', 'bitRate', 'encoding', 'colorProfile')


def settings_hash(request):
    signature = request.get('renderSignature')
    try:
        render = json.loads(signature) if isinstance(signature, str) else signature
    except ValueError:
        render = signature
    if isinstance(render, dict):
        render = {key: value for key, value in render.items() if key != 'sourceUrl'}
    music = request.get('music')
    if isinstance(music, dict):
        # scoreHash fingerprints rendered pixels, a result rather than a setting.
        music = {key: value for key, value in music.items() if key != 'scoreHash'}
    canonical = {'render': render, 'music': music, **{field: request.get(field) for field in OUTPUT_FIELDS}}
    text = json.dumps(canonical, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:8]
