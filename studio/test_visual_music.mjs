/* Copyright 2026 Michael Pilosov. All rights reserved. */
import assert from 'node:assert/strict';
import {MUSIC_SCHEMA, PRESETS, analysisFrame, analysisIndex, analyzeRGBA, compositionAt, random01, stepSeconds} from '../visual-music-core.js';

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

// Live playback and export share one analysis timeline in loop time.
assert.equal(analysisIndex(0), 0);
assert.equal(analysisIndex(3 / 8), 3, 'exact boundaries do not floor to the previous analysis');
assert.equal(analysisIndex(11 / 30), 2, 'frame 11 at 30 FPS is still within analysis 2');
assert.equal(analysisFrame(3, 30), 11, 'analysis 3 at 30 FPS reads frame round(11.25)');
assert.equal(analysisFrame(1, 30), 4);
assert.equal(analysisFrame(8, 60), 60);
for (const fps of [24, 30, 60]) {
    for (let index = 0; index < 400; index++) {
        // Reaching an analysis frame during playback selects that same analysis.
        const frame = analysisFrame(index, fps);
        assert(analysisIndex(frame / fps) <= index && analysisIndex((frame + 1) / fps) >= index, `${fps} fps, analysis ${index}`);
    }
}
for (const tempo of [60, 88, 120, 137]) {
    for (let step = 0; step < 2000; step++) {
        // The live step counter and the export's step times agree on every step's analysis.
        const seconds = stepSeconds(step, tempo);
        assert.equal(Math.floor(seconds * tempo / 60 * 4 + 1e-9), step);
        assert.equal(analysisIndex(seconds), analysisIndex(step * (60 / tempo / 4)), `tempo ${tempo} step ${step}`);
    }
}
