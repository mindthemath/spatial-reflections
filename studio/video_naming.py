# Copyright 2026 Michael Pilosov. All rights reserved.
"""Scene/music identity for export names, independent of delivery settings.

The suffix of `<label>-<UTC timestamp>-<hash>.<ext>` groups exports of the same
scene and musical configuration. Range, resolution, FPS, encoding and full-loop
post-processing remain in provenance, not in this identity. Synth versions count.
"""

import hashlib
import json

MUSIC_IDENTITY_FIELDS = ('schema', 'enabled', 'settings', 'analysisRender', 'synthesis')


def settings_hash(request):
    signature = request.get('renderSignature')
    try:
        render = json.loads(signature) if isinstance(signature, str) else signature
    except ValueError:
        render = signature
    if isinstance(render, dict):
        # Keep the full signature unchanged for resume safety; filter only the
        # filename identity. FPS is an export setting embedded in the signature.
        render = {key: value for key, value in render.items() if key not in ('sourceUrl', 'fps')}
    music = request.get('music')
    if isinstance(music, dict):
        # Sample counts/format, pixel-derived score hashes and the full-loop
        # overlap describe the deliverable, not its scene/musical configuration.
        music = {key: music[key] for key in MUSIC_IDENTITY_FIELDS if key in music}
    canonical = {'render': render, 'music': music}
    text = json.dumps(canonical, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(text.encode('utf-8')).hexdigest()[:8]
