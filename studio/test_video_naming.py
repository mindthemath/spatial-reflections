# Copyright 2026 Michael Pilosov. All rights reserved.
import json
import unittest

from studio.video_naming import settings_hash


def request(**changes):
    signature = {
        'sourceUrl': '/?skybox=exports%2Fmill1', 'rotationSpeed': 0.005,
        'rotationCoefficients': {'xw': 0.7, 'yw': -0.05, 'zw': 0.55}, 'shader': 'chrome',
        'lighting': 'diagonal', 'lightDistance': 0.1, 'showVertices': False, 'surfaceGrain': False,
        'camera': {'position': [0.24, 0.01, 0.63], 'target': [0.02, 0.1, -0.04]}, 'fps': 30,
        'music': {'preset': 'abyssdrive', 'enabled': True, 'seed': 1701},
        'environment': '{"kind":"export","faces":{"px":"ab"}}',
    }
    signature.update(changes.pop('signature', {}))
    base = {
        'name': 'mill1', 'width': 1920, 'height': 1080, 'fps': 30, 'frames': 900, 'startFrame': 10900,
        'timeStep': 0.005, 'loopFrameCount': 25133, 'quality': 'capped', 'format': 'mp4',
        'bitRate': 49766400, 'encoding': {'crf': 12}, 'colorProfile': 'srgb-limited-v1',
        'checkpointSeconds': 60, 'scratchPath': '/tmp', 'estimatedBytes': 1,
        'sourceUrl': '/?skybox=exports%2Fmill1', 'viewerState': {'panelExpanded': True},
        'music': {'schema': 'v1', 'enabled': True, 'samples': 1440000, 'settings': {'seed': 1701},
                  'scoreHash': 'a' * 64},
        'renderSignature': json.dumps(signature),
    }
    base.update(changes)
    return base


class SettingsHashTest(unittest.TestCase):
    def test_identical_settings_share_a_hash(self):
        self.assertRegex(settings_hash(request()), r'^[0-9a-f]{8}$')
        self.assertEqual(settings_hash(request()), settings_hash(request()))

    def test_key_order_does_not_matter(self):
        shuffled = dict(reversed(list(request().items())))
        self.assertEqual(settings_hash(shuffled), settings_hash(request()))

    def test_non_output_details_do_not_change_the_hash(self):
        baseline = settings_hash(request())
        for changes in ({'name': 'other'}, {'checkpointSeconds': 0}, {'scratchPath': ''},
                        {'estimatedBytes': 2}, {'viewerState': {'panelExpanded': False}},
                        {'sourceUrl': '/?soundframe=16:9'},
                        {'signature': {'sourceUrl': '/?skybox=x&?soundframe=16:9'}},
                        {'music': {**request()['music'], 'scoreHash': 'b' * 64}}):
            with self.subTest(changes=changes):
                self.assertEqual(settings_hash(request(**changes)), baseline)

    def test_delivery_settings_do_not_change_the_hash(self):
        baseline = settings_hash(request())
        for changes in ({'startFrame': 0}, {'frames': 25133}, {'quality': 'master'}, {'format': 'mkv'},
                        {'width': 1280}, {'height': 720}, {'fps': 60}, {'bitRate': 100000},
                        {'encoding': {'crf': 13}}, {'colorProfile': 'other'},
                        {'signature': {'fps': 60}},
                        {'music': {**request()['music'], 'samples': 40212800, 'loopCrossfadeSeconds': 2.5}},
                        {'music': {**request()['music'], 'sampleRate': 96000, 'channels': 1}}):
            with self.subTest(changes=changes):
                self.assertEqual(settings_hash(request(**changes)), baseline)
        full = request(startFrame=0, frames=25133, fps=60, width=1280, quality='master',
                       signature={'fps': 60},
                       music={**request()['music'], 'samples': 40212800, 'loopCrossfadeSeconds': 2.5})
        self.assertEqual(settings_hash(full), baseline, 'clip and full variants share scene/music identity')

    def test_scene_and_music_settings_change_the_hash(self):
        baseline = settings_hash(request())
        for changes in ({'signature': {'surfaceGrain': True}},
                        {'signature': {'dirtyMirrors': True}},
                        {'signature': {'rotationSpeed': .006}},
                        {'music': {**request()['music'], 'synthesis': 'whole-timeline-v3'}},
                        {'music': {**request()['music'], 'analysisRender': 'different'}},
                        {'signature': {'camera': {'position': [0.25, 0.01, 0.63], 'target': [0.02, 0.1, -0.04]}}},
                        {'signature': {'music': {'preset': 'abyssdrive', 'enabled': True, 'seed': 1702}}},
                        {'signature': {'environment': '{"kind":"export","faces":{"px":"cd"}}'}},
                        {'music': {**request()['music'], 'settings': {'seed': 1702}}}):
            with self.subTest(changes=changes):
                self.assertNotEqual(settings_hash(request(**changes)), baseline)


if __name__ == '__main__':
    unittest.main()
