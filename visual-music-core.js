// Pure deterministic composition helpers for the visual-music prototype.
// This module deliberately has no DOM or Web Audio dependencies so its musical
// decisions can be fixture-tested and later reused by an export renderer.

export const MUSIC_SCHEMA = 'spatial-reflections-music-v1';

export function hash32(...values) {
    let hash = 0x811c9dc5;
    for (const value of values) {
        const text = String(value);
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        hash ^= 0x9e3779b9;
        hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    }
    return (hash ^ (hash >>> 16)) >>> 0;
}

export function random01(seed, step, stream = 0) {
    let x = hash32(seed, step, stream) || 1;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
}

export function quantize(value, levels = 1024) {
    return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * levels) / levels;
}

export function analyzeRGBA(data, width, height, previousLuma = null) {
    if (!data || width < 2 || height < 2 || data.length < width * height * 4) {
        throw new Error('Pixel analysis requires a complete RGBA image');
    }
    const count = width * height;
    const luma = new Float32Array(count);
    let sum = 0, sum2 = 0, red = 0, green = 0, blue = 0, activeCount = 0;
    let weightedX = 0, weightedY = 0, weight = 0;
    const regions = new Float64Array(12);
    const regionCounts = new Uint32Array(12);
    for (let y = 0, pixel = 0; y < height; y++) {
        for (let x = 0; x < width; x++, pixel++) {
            const offset = pixel * 4;
            const r = data[offset] / 255;
            const g = data[offset + 1] / 255;
            const b = data[offset + 2] / 255;
            const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            luma[pixel] = value;
            // The viewer intentionally has a black void around the object. Treat
            // that as negative space rather than allowing viewport size to drown
            // out the reflected pixels that actually carry the composition.
            if (value > 2 / 255) {
                sum += value;
                sum2 += value * value;
                red += r; green += g; blue += b;
                activeCount++;
            }
            const brightWeight = value * value;
            weightedX += brightWeight * x / (width - 1);
            weightedY += brightWeight * y / (height - 1);
            weight += brightWeight;
            const regionX = Math.min(3, Math.floor(x * 4 / width));
            const regionY = Math.min(2, Math.floor(y * 3 / height));
            const region = regionY * 4 + regionX;
            regions[region] += value;
            regionCounts[region]++;
        }
    }
    let edges = 0, edgeCount = 0, motion = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (x) { edges += Math.abs(luma[index] - luma[index - 1]); edgeCount++; }
            if (y) { edges += Math.abs(luma[index] - luma[index - width]); edgeCount++; }
            if (previousLuma?.length === count) motion += Math.abs(luma[index] - previousLuma[index]);
        }
    }
    const measuredCount = Math.max(1, activeCount);
    const mean = sum / measuredCount;
    const colorTotal = red + green + blue || 1;
    const regionMeans = Array.from(regions, (value, index) => value / regionCounts[index]);
    const regionPeak = Math.max(1 / 255, ...regionMeans);
    const normalizedRegions = regionMeans.map(value => quantize(value / regionPeak));
    const left = normalizedRegions[0] + normalizedRegions[4] + normalizedRegions[8]
        + normalizedRegions[1] + normalizedRegions[5] + normalizedRegions[9];
    const right = normalizedRegions[2] + normalizedRegions[6] + normalizedRegions[10]
        + normalizedRegions[3] + normalizedRegions[7] + normalizedRegions[11];
    return {
        features: Object.freeze({
            luminance: quantize(mean),
            contrast: quantize(Math.sqrt(Math.max(0, sum2 / measuredCount - mean * mean)) * 2.5),
            edge: quantize(edges / Math.max(1, edgeCount) * 10),
            motion: quantize(previousLuma ? motion / count * 12 : 0),
            red: quantize(red / colorTotal),
            green: quantize(green / colorTotal),
            blue: quantize(blue / colorTotal),
            centroidX: quantize(weight ? weightedX / weight : 0.5),
            centroidY: quantize(weight ? weightedY / weight : 0.5),
            balance: quantize(0.5 + (right - left) / 12),
            regions: Object.freeze(normalizedRegions)
        }),
        luma
    };
}

export const MODES = Object.freeze({
    // Consonant anchors with controlled access to semitone and tritone color.
    veil: Object.freeze([0, 2, 3, 5, 7, 9, 10]),
    abyss: Object.freeze([0, 1, 3, 5, 7, 8, 10]),
    glass: Object.freeze([0, 2, 3, 6, 7, 9, 11])
});

export const PRESETS = Object.freeze({
    cathedral: Object.freeze({label: 'Cathedral glass', density: 0.52, tension: 0.42, influence: 0.72, space: 0.82, tempo: 52,
        layers: {drone: 0.82, field: 0.72, bells: 0.55, pulse: 0.28, metal: 0.36, texture: 0.28}}),
    ruins: Object.freeze({label: 'Signal ruins', density: 0.68, tension: 0.68, influence: 0.86, space: 0.65, tempo: 61,
        layers: {drone: 0.70, field: 0.62, bells: 0.42, pulse: 0.58, metal: 0.62, texture: 0.48}}),
    blackice: Object.freeze({label: 'Black ice', density: 0.38, tension: 0.56, influence: 0.92, space: 0.90, tempo: 44,
        layers: {drone: 0.64, field: 0.52, bells: 0.82, pulse: 0.18, metal: 0.48, texture: 0.20}}),
    abyssdrive: Object.freeze({label: 'Abyss drive', level: 1.00, density: 0.33, tension: 0.88, influence: 0.87, space: 0.30, tempo: 88, seed: 1701,
        layers: {drone: 1.00, field: 0.00, bells: 0.99, pulse: 0.96, metal: 0.11, texture: 0.07}})
});

export function compositionAt({seed, step, settings, features}) {
    const tension = settings.tension;
    const influence = settings.influence;
    const bar = Math.floor(step / 16);
    const phrase = Math.floor(step / 64);
    const modeNames = ['veil', 'abyss', 'glass'];
    const colorBias = features.red * 0.7 + features.blue * 1.6 + features.green * 2.4;
    const modeIndex = Math.floor((random01(seed, phrase, 1) * 3 * (1 - influence) + colorBias * influence)) % 3;
    const modeName = modeNames[modeIndex];
    const mode = MODES[modeName];
    const baseMidi = 31 + (hash32(seed, 'root') % 7);
    const visualDegree = Math.floor((features.centroidX * 2 + features.centroidY + features.red) * mode.length) % mode.length;
    const randomDegree = Math.floor(random01(seed, bar, 2) * mode.length);
    const degree = mode[Math.round(visualDegree * influence + randomDegree * (1 - influence)) % mode.length];
    const rootMidi = baseMidi + degree;
    const brightness = features.luminance * influence + 0.28 * (1 - influence);
    const agitation = Math.min(1, features.motion * 0.7 + features.edge * 0.45 + features.contrast * 0.35);
    const dissonant = random01(seed, bar, 3) < tension * (0.28 + agitation * 0.5);
    const colorInterval = dissonant ? (random01(seed, bar, 4) < 0.5 ? 1 : 6) : (modeName === 'glass' ? 11 : 10);
    const chord = [0, 7, 12 + mode[2], 19, 24 + colorInterval];
    return Object.freeze({
        schema: MUSIC_SCHEMA,
        step, bar, phrase, modeName, rootMidi, chord: Object.freeze(chord),
        brightness, agitation,
        pan: (features.balance - 0.5) * 1.7,
        bellRegion: Math.floor(random01(seed, step, 5) * features.regions.length),
        bell: random01(seed, step, 6) < settings.density * (0.12 + features.edge * influence * 0.58),
        metal: random01(seed, step, 7) < settings.density * tension * (0.04 + features.contrast * 0.32),
        texture: random01(seed, step, 8) < settings.density * (0.05 + features.motion * influence * 0.42),
        pulse: step % 4 === 0 || (step % 2 === 0 && random01(seed, step, 9) < settings.density * agitation * 0.5),
        upper: random01(seed, step, 10) < settings.density * (0.04 + brightness * 0.16)
    });
}

export function midiFrequency(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
}
