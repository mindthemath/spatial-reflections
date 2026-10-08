import assert from 'node:assert/strict';
import {MUSIC_SCHEMA, PRESETS, analyzeRGBA, compositionAt, random01} from '../visual-music-core.js';

assert.deepEqual(PRESETS.abyssdrive, {
    label: 'Abyss drive', level: 1, density: .33, tension: .88, influence: .87,
    space: .30, tempo: 88, seed: 1701,
    layers: {drone: 1, field: 0, bells: .99, pulse: .96, metal: .11, texture: .07}
});

const width = 12, height = 8;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        pixels[offset] = x * 19;
        pixels[offset + 1] = y * 29;
        pixels[offset + 2] = (x + y) * 11;
        pixels[offset + 3] = 255;
    }
}
const first = analyzeRGBA(pixels, width, height);
const repeated = analyzeRGBA(pixels, width, height);
assert.deepEqual(first.features, repeated.features, 'pixel analysis is deterministic');
assert.equal(first.features.regions.length, 12);
assert(first.features.centroidX > .5, 'the bright side moves the visual centroid');

const changed = pixels.slice();
for (let index = 0; index < changed.length; index += 4) changed[index + 2] = 255;
const moving = analyzeRGBA(changed, width, height, first.luma);
assert(moving.features.motion > 0, 'frame differences become motion');
assert(moving.features.blue > first.features.blue, 'color changes affect chroma');

const settings = {density: .62, tension: .58, influence: .83};
const input = {seed: 1701, step: 96, settings, features: first.features};
const score = compositionAt(input);
assert.deepEqual(score, compositionAt(input), 'the same pixels, step, seed and controls make the same score');
assert.equal(score.schema, MUSIC_SCHEMA);
assert.notEqual(random01(1701, 96, 2), random01(1702, 96, 2), 'variation changes deterministic choices');
assert.notDeepEqual(
    compositionAt(input),
    compositionAt({...input, features: moving.features}),
    'changed pixels change the composition'
);
console.log('PASS: deterministic pixel analysis, motion, chroma, seeded score and visual coupling.');
