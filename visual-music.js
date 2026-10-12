/* Copyright 2026 Michael Pilosov. All rights reserved. */
import {PRESETS, analysisFrame, analysisIndex, analyzeRGBA, compositionAt, hash32, midiFrequency, random01, stepSeconds} from './visual-music-core.js';

const STORAGE_KEY = 'spatial-reflections.music-prototype.v1';
const DEFAULTS = {
    preset: 'cathedral', enabled: false, level: 0.72, seed: 1701,
    ...PRESETS.cathedral, layers: {...PRESETS.cathedral.layers}
};
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const lerp = (a, b, amount) => a + (b - a) * amount;
const dbGain = db => Math.pow(10, db / 20);

function loadSettings(initialSettings = null) {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        const source = initialSettings && typeof initialSettings === 'object' ? initialSettings : saved;
        return normalizeSettings({...DEFAULTS, ...source, layers: {...DEFAULTS.layers, ...source?.layers}});
    } catch {
        return normalizeSettings({...DEFAULTS, ...initialSettings, layers: {...DEFAULTS.layers, ...initialSettings?.layers}});
    }
}

function normalizeSettings(value) {
    return {
        preset: value.preset === 'custom' || PRESETS[value.preset] ? value.preset : 'cathedral',
        enabled: Boolean(value.enabled),
        level: clamp(value.level),
        density: clamp(value.density),
        tension: clamp(value.tension),
        influence: clamp(value.influence),
        space: clamp(value.space),
        tempo: Math.round(clamp(value.tempo, 36, 88)),
        seed: Math.max(1, Math.min(999999, Math.trunc(Number(value.seed) || DEFAULTS.seed))),
        layers: Object.fromEntries(Object.keys(DEFAULTS.layers).map(key => [key, clamp(value.layers?.[key])]))
    };
}

function makeSlider(id, label, value, min, max, step, format = number => number.toFixed(2)) {
    const row = document.createElement('label');
    row.className = 'music-slider';
    row.htmlFor = id;
    const heading = document.createElement('span');
    heading.innerHTML = `<span>${label}</span><output>${format(value)}</output>`;
    const input = document.createElement('input');
    Object.assign(input, {id, type: 'range', min: String(min), max: String(max), step: String(step), value: String(value)});
    row.append(heading, input);
    return {row, input, output: heading.querySelector('output'), format};
}

function createNoiseBuffer(context, seconds, seed) {
    const length = Math.max(1, Math.round(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let state = hash32(seed, length) || 1;
    let brown = 0;
    for (let index = 0; index < length; index++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        const white = ((state >>> 0) / 2147483648) - 1;
        brown = brown * 0.985 + white * 0.055;
        channel[index] = clamp(brown * 2.8, -1, 1);
    }
    return buffer;
}

function setParam(param, value, time, glide = 0.05) {
    param.cancelScheduledValues(time);
    param.setTargetAtTime(value, time, glide);
}

class SpatialMusicEngine {
    constructor(canvas, onStatus, initialSettings = null, onStateChange = null) {
        this.canvas = canvas;
        this.onStatus = onStatus;
        this.onStateChange = onStateChange;
        this.settings = loadSettings(initialSettings);
        this.context = null;
        this.nodes = null;
        this.previousLuma = null;
        this.features = {luminance: .15, contrast: .2, edge: .1, motion: 0, red: .33, green: .33, blue: .34,
            centroidX: .5, centroidY: .5, balance: .5, regions: Array(12).fill(.15)};
        this.analysisCanvas = document.createElement('canvas');
        this.analysisCanvas.width = 48;
        this.analysisCanvas.height = 27;
        this.analysisContext = this.analysisCanvas.getContext('2d', {willReadFrequently: true, alpha: false});
        this.lastAnalysisIndex = null;
        this.analysisMemo = new Map();
        this.lastStep = null;
        this.lastFrame = null;
        this.lastComposition = null;
        this.sustains = [];
        this.sources = new Set();
    }

    save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({...this.settings, enabled: undefined})); } catch { /* optional */ }
    }

    async start() {
        if (!this.context) this.buildAudioGraph();
        await this.context.resume();
        this.settings.enabled = true;
        const {frame = 0, fps = 30} = this.timeline || {};
        this.lastStep = Math.floor(frame / fps * this.settings.tempo / 60 * 4);
        this.features = this.analyzeAt(analysisIndex(frame / fps), fps);
        this.lastAnalysisIndex = analysisIndex(frame / fps);
        this.lastFrame = frame;
        this.rebuildSustains();
        this.updateMix();
        this.onStatus('Listening to the framebuffer… play the geometry to drive events.', 'running');
        this.onStateChange?.();
    }

    stop() {
        this.settings.enabled = false;
        this.releaseSustains(1.2);
        if (this.nodes && this.context) setParam(this.nodes.master.gain, 0.0001, this.context.currentTime, .18);
        this.onStatus('Soundtrack stopped.', 'idle');
        this.onStateChange?.();
    }

    buildAudioGraph(suppliedContext = null) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!suppliedContext && !AudioContextClass) throw new Error('This browser does not provide Web Audio');
        const context = this.context = suppliedContext || new AudioContextClass({latencyHint: 'interactive'});
        const master = context.createGain();
        const dry = context.createGain();
        const wet = context.createGain();
        const delaySend = context.createGain();
        const delay = context.createDelay(2);
        const feedback = context.createGain();
        const delayFilter = context.createBiquadFilter();
        const convolver = context.createConvolver();
        const compressor = context.createDynamicsCompressor();
        const highpass = context.createBiquadFilter();
        highpass.type = 'highpass'; highpass.frequency.value = 24; highpass.Q.value = .65;
        compressor.threshold.value = -18; compressor.knee.value = 14; compressor.ratio.value = 3.5;
        compressor.attack.value = .015; compressor.release.value = .42;
        delay.delayTime.value = .72; feedback.gain.value = .31;
        delayFilter.type = 'lowpass'; delayFilter.frequency.value = 2400;
        convolver.buffer = this.createImpulse(5.8, this.settings.seed);
        master.connect(dry); master.connect(wet); master.connect(delaySend);
        dry.connect(highpass); wet.connect(convolver).connect(highpass);
        delaySend.connect(delay).connect(delayFilter).connect(highpass);
        delayFilter.connect(feedback).connect(delay);
        highpass.connect(compressor).connect(context.destination);
        this.nodes = {master, dry, wet, delaySend, delay, feedback, delayFilter, convolver, compressor, highpass};
        this.updateMix();
    }

    createImpulse(seconds, seed) {
        const context = this.context;
        const length = Math.round(context.sampleRate * seconds);
        const impulse = context.createBuffer(2, length, context.sampleRate);
        for (let channel = 0; channel < 2; channel++) {
            const data = impulse.getChannelData(channel);
            let state = hash32(seed, 'space', channel) || 1;
            let low = 0;
            for (let i = 0; i < length; i++) {
                state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
                const white = ((state >>> 0) / 2147483648) - 1;
                low = low * .72 + white * .28;
                const time = i / length;
                const early = i < context.sampleRate * .12 ? (i % 887 === 0 ? .8 : .12) : 1;
                data[i] = (white * .72 + low * .28) * Math.pow(1 - time, 2.3) * early;
            }
        }
        return impulse;
    }

    updateMix() {
        if (!this.nodes || !this.context) return;
        const now = this.context.currentTime;
        const active = this.settings.enabled ? dbGain(-15 + this.settings.level * 11) : .0001;
        setParam(this.nodes.master.gain, active, now, .12);
        setParam(this.nodes.dry.gain, lerp(.94, .48, this.settings.space), now, .2);
        setParam(this.nodes.wet.gain, lerp(.08, .68, this.settings.space), now, .25);
        setParam(this.nodes.delaySend.gain, lerp(.02, .24, this.settings.space), now, .25);
        setParam(this.nodes.feedback.gain, lerp(.18, .46, this.settings.space), now, .3);
        this.nodes.delay.delayTime.setTargetAtTime(60 / this.settings.tempo * .75, now, .2);
    }

    connectVoice(node, pan = 0, destination = this.nodes.master) {
        if (this.context.createStereoPanner) {
            const panner = this.context.createStereoPanner();
            panner.pan.value = clamp(pan, -1, 1);
            node.connect(panner).connect(destination);
            return panner;
        }
        node.connect(destination);
        return destination;
    }

    track(source) {
        this.sources.add(source);
        source.addEventListener('ended', () => this.sources.delete(source), {once: true});
        return source;
    }

    // Analysis k renders exactly the frames an export reads (k, and k-1 for
    // motion), so dropped frames, seeks or window size never change the score.
    analyzeAt(index, fps) {
        const key = `${fps}:${index}`;
        if (this.analysisMemo.has(key)) return this.analysisMemo.get(key);
        try {
            let features;
            if (this.sampleFrame) {
                const read = frame => {
                    const image = this.sampleFrame(frame);
                    return [image.data, image.width, image.height];
                };
                const previous = index > 0 ? analyzeRGBA(...read(analysisFrame(index - 1, fps))).luma : null;
                features = analyzeRGBA(...read(analysisFrame(index, fps)), previous).features;
            } else {
                // Without a host renderer, fall back to the visible canvas.
                const context = this.analysisContext;
                context.drawImage(this.canvas, 0, 0, 48, 27);
                const analysis = analyzeRGBA(context.getImageData(0, 0, 48, 27).data, 48, 27, this.previousLuma);
                this.previousLuma = analysis.luma;
                features = analysis.features;
            }
            this.analysisMemo.set(key, features);
            if (this.analysisMemo.size > 4) this.analysisMemo.delete(this.analysisMemo.keys().next().value);
            return features;
        } catch (error) {
            this.onStatus(`Pixel analysis unavailable: ${error.message}`, 'error');
            return this.features;
        }
    }

    tick({frame, fps, paused}) {
        this.timeline = {frame, fps};
        if (!this.settings.enabled || !this.context || this.context.state !== 'running') return;
        const index = analysisIndex(frame / fps);
        if (index !== this.lastAnalysisIndex) {
            this.lastAnalysisIndex = index;
            this.features = this.analyzeAt(index, fps);
            this.modulateSustains();
        }
        const visualSeconds = frame / fps;
        const step = Math.floor(visualSeconds * this.settings.tempo / 60 * 4);
        const discontinuity = this.lastFrame !== null && Math.abs(frame - this.lastFrame) > Math.max(4, fps / 2);
        if (discontinuity || step < (this.lastStep ?? step)) {
            this.lastStep = step;
            this.analysisMemo.clear();
            this.releaseSustains(.8);
            this.rebuildSustains();
        }
        this.lastFrame = frame;
        // Starting/unmuting/seeking joins the current step without replaying its
        // attack. Events only fire when the timeline crosses the next step.
        if (this.lastStep === null) {
            this.lastStep = step;
            return;
        }
        if (paused || step === this.lastStep) return;
        // Do not fire a backlog after hidden-tab throttling or a timeline seek.
        this.lastStep = step;
        this.performStep(step, fps);
    }

    performStep(step, fps) {
        const now = this.context.currentTime + .018;
        // Each step hears the analysis for its own musical time, exactly as in export.
        const features = this.analyzeAt(analysisIndex(stepSeconds(step, this.settings.tempo)), fps);
        const score = compositionAt({seed: this.settings.seed, step, settings: this.settings, features});
        this.lastComposition = score;
        if (step > 0 && step % 16 === 0) this.playHarmonicField(score, now);
        if (score.pulse) this.playUndertow(score, now);
        if (score.bell) this.playBell(score, now);
        if (score.metal) this.playMetal(score, now);
        if (score.texture) this.playTexture(score, now);
        if (score.upper) this.playShimmer(score, now);
        this.onStatus(`${score.modeName.toUpperCase()} · root ${this.noteName(score.rootMidi)} · frame drives ${(this.features.motion * 100).toFixed(0)}% motion / ${(this.features.edge * 100).toFixed(0)}% edge`, 'running');
    }

    noteName(midi) {
        const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
        return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
    }

    releaseSustains(seconds = 2) {
        if (!this.context) return;
        const now = this.context.currentTime;
        for (const voice of this.sustains.splice(0)) {
            voice.gain.gain.cancelScheduledValues(now);
            voice.gain.gain.setTargetAtTime(.0001, now, Math.max(.05, seconds / 4));
            for (const oscillator of voice.oscillators) {
                try { oscillator.stop(now + seconds); } catch { /* already stopped */ }
            }
        }
    }

    rebuildSustains() {
        if (!this.context || !this.settings.enabled) return;
        this.releaseSustains(.7);
        const score = compositionAt({seed: this.settings.seed, step: this.lastStep || 0, settings: this.settings, features: this.features});
        const now = this.context.currentTime;
        // Four independently moving partial groups form a drone rather than a single chord pad.
        const intervals = [0, 7, 12 + (score.modeName === 'abyss' ? 1 : 3), 24 + (this.settings.tension > .6 ? 6 : 10)];
        intervals.forEach((interval, index) => {
            const gain = this.context.createGain();
            const filter = this.context.createBiquadFilter();
            const pan = [-.72, .46, -.18, .78][index];
            filter.type = index === 0 ? 'lowpass' : 'bandpass';
            filter.frequency.value = index === 0 ? 420 : 260 + index * 310;
            filter.Q.value = index === 0 ? .55 : 1.2 + index;
            gain.gain.setValueAtTime(.0001, now);
            gain.gain.exponentialRampToValueAtTime((.032 / (1 + index * .28)) * this.settings.layers.drone, now + 3.5 + index);
            gain.connect(filter);
            this.connectVoice(filter, pan);
            const oscillators = [];
            const base = midiFrequency(score.rootMidi + interval);
            [-7.5, 0, 6.2].forEach((cents, partial) => {
                const oscillator = this.context.createOscillator();
                oscillator.type = partial === 1 ? 'sine' : (index % 2 ? 'triangle' : 'sawtooth');
                oscillator.frequency.value = base * Math.pow(2, cents / 1200) * (partial === 2 && index > 1 ? 2.003 : 1);
                const partialGain = this.context.createGain();
                partialGain.gain.value = [0.18, .72, .09][partial];
                oscillator.connect(partialGain).connect(gain);
                oscillator.start(now + index * .04);
                oscillators.push(oscillator);
            });
            this.sustains.push({gain, filter, oscillators, index, interval});
        });
    }

    // Shared by live playback (now) and offline export (each analysis time), so
    // drones glide identically in both.
    modulateSustains(now = this.context?.currentTime, features = this.features) {
        if (!this.context) return;
        const influence = this.settings.influence;
        const luminance = lerp(.24, features.luminance, influence);
        const contrast = lerp(.18, features.contrast, influence);
        const edge = lerp(.12, features.edge, influence);
        const centroidX = lerp(.5, features.centroidX, influence);
        for (const voice of this.sustains) {
            const cutoff = 160 + voice.index * 250 + luminance * 1800 + edge * 900;
            setParam(voice.filter.frequency, cutoff, now, .35 + voice.index * .15);
            voice.filter.Q.setTargetAtTime(.65 + contrast * (2 + voice.index), now, .4);
            const gain = (.025 + luminance * .018) * this.settings.layers.drone / (1 + voice.index * .22);
            setParam(voice.gain.gain, gain, now, .6);
            voice.oscillators.forEach((oscillator, partial) => {
                oscillator.detune.setTargetAtTime((centroidX - .5) * (partial - 1) * 13, now, .8);
            });
        }
    }

    envelope(gain, now, peak, attack, hold, release) {
        gain.gain.setValueAtTime(.0001, now);
        gain.gain.exponentialRampToValueAtTime(Math.max(.0002, peak), now + attack);
        gain.gain.setValueAtTime(Math.max(.0002, peak), now + attack + hold);
        gain.gain.exponentialRampToValueAtTime(.0001, now + attack + hold + release);
        return now + attack + hold + release + .05;
    }

    playHarmonicField(score, now) {
        const level = this.settings.layers.field;
        if (!level) return;
        const duration = 60 / this.settings.tempo * 7.5;
        score.chord.slice(1).forEach((interval, index) => {
            const oscillator = this.track(this.context.createOscillator());
            const shadow = this.track(this.context.createOscillator());
            const gain = this.context.createGain();
            const filter = this.context.createBiquadFilter();
            oscillator.type = index % 2 ? 'triangle' : 'sine';
            shadow.type = 'sine';
            const frequency = midiFrequency(score.rootMidi + 12 + interval);
            oscillator.frequency.value = frequency;
            shadow.frequency.value = frequency * (index === 3 ? 1.498 : 1.0035);
            const shadowGain = this.context.createGain();
            shadowGain.gain.value = index === 3 ? .08 * this.settings.tension : .13;
            filter.type = 'lowpass';
            filter.frequency.value = 700 + score.brightness * 2600 + index * 340;
            filter.Q.value = 1.1 + this.settings.tension * 2.5;
            oscillator.connect(gain); shadow.connect(shadowGain).connect(gain); gain.connect(filter);
            this.connectVoice(filter, clamp(score.pan + (index - 1.5) * .32, -1, 1));
            const stop = this.envelope(gain, now + index * .07, (.018 + score.brightness * .012) * level, 1.6 + index * .5, duration * .45, duration);
            oscillator.start(now); shadow.start(now); oscillator.stop(stop); shadow.stop(stop);
        });
    }

    playUndertow(score, now) {
        const level = this.settings.layers.pulse;
        if (!level) return;
        const frequency = midiFrequency(score.rootMidi - 12 + (score.step % 16 === 12 ? 7 : 0));
        const gain = this.context.createGain();
        const filter = this.context.createBiquadFilter();
        filter.type = 'lowpass'; filter.frequency.value = 120 + score.agitation * 220; filter.Q.value = 1.4;
        gain.connect(filter); this.connectVoice(filter, score.pan * .2);
        const stop = this.envelope(gain, now, (.07 + score.agitation * .035) * level, .045, .18, 1.3);
        ['sine', 'triangle'].forEach((type, index) => {
            const oscillator = this.track(this.context.createOscillator());
            const voiceGain = this.context.createGain();
            oscillator.type = type;
            oscillator.frequency.setValueAtTime(frequency * (index ? 2 : 1) * 1.012, now);
            oscillator.frequency.exponentialRampToValueAtTime(frequency * (index ? 2 : 1), now + .42);
            voiceGain.gain.value = index ? .18 : .9;
            oscillator.connect(voiceGain).connect(gain); oscillator.start(now); oscillator.stop(stop);
        });
    }

    playBell(score, now) {
        const level = this.settings.layers.bells;
        if (!level) return;
        const region = lerp(.24, this.features.regions[score.bellRegion] || .2, this.settings.influence);
        const degree = score.chord[1 + (score.bellRegion % (score.chord.length - 1))];
        const frequency = midiFrequency(score.rootMidi + 24 + degree);
        const carrier = this.track(this.context.createOscillator());
        const modulator = this.track(this.context.createOscillator());
        const modulation = this.context.createGain();
        const gain = this.context.createGain();
        const filter = this.context.createBiquadFilter();
        carrier.type = 'sine'; modulator.type = 'sine';
        carrier.frequency.value = frequency;
        modulator.frequency.value = frequency * lerp(1.37, 2.71, this.settings.tension);
        modulation.gain.setValueAtTime(frequency * (1.2 + this.settings.tension * 4), now);
        modulation.gain.exponentialRampToValueAtTime(.01, now + 1.4 + this.settings.space * 3);
        modulator.connect(modulation).connect(carrier.frequency);
        filter.type = 'highpass'; filter.frequency.value = 260;
        carrier.connect(gain).connect(filter);
        const regionX = (score.bellRegion % 4) / 3;
        this.connectVoice(filter, regionX * 1.8 - .9);
        const stop = this.envelope(gain, now, (.025 + region * .045) * level, .004, .02, 2.4 + this.settings.space * 4.8);
        carrier.start(now); modulator.start(now); carrier.stop(stop); modulator.stop(stop);
    }

    playMetal(score, now) {
        const level = this.settings.layers.metal;
        if (!level) return;
        const base = midiFrequency(score.rootMidi + 19 + (score.step % 3) * 5);
        const gain = this.context.createGain();
        const band = this.context.createBiquadFilter();
        band.type = 'bandpass'; band.frequency.value = base * 2.2; band.Q.value = 2.8 + this.settings.tension * 7;
        gain.connect(band); this.connectVoice(band, -score.pan);
        const stop = this.envelope(gain, now, .028 * level, .008, .03, 1.1 + this.settings.space * 2.7);
        [1, 1.4142, 2.731, 4.117].forEach((ratio, index) => {
            const oscillator = this.track(this.context.createOscillator());
            const partialGain = this.context.createGain();
            oscillator.type = 'sine'; oscillator.frequency.value = base * ratio;
            partialGain.gain.value = 1 / (1 + index * 1.7);
            oscillator.connect(partialGain).connect(gain); oscillator.start(now); oscillator.stop(stop);
        });
    }

    playTexture(score, now) {
        const level = this.settings.layers.texture;
        if (!level) return;
        const duration = .5 + score.agitation * 2.2;
        const source = this.track(this.context.createBufferSource());
        source.buffer = createNoiseBuffer(this.context, duration, hash32(this.settings.seed, score.step, 'texture'));
        const band = this.context.createBiquadFilter();
        const gain = this.context.createGain();
        band.type = 'bandpass';
        band.frequency.value = 180 + lerp(.5, this.features.centroidY, this.settings.influence) * 2600;
        band.Q.value = 4 + this.settings.tension * 12;
        source.connect(band).connect(gain); this.connectVoice(gain, score.pan);
        const stop = this.envelope(gain, now, .018 * level, .08, duration * .25, duration * .65);
        source.start(now); source.stop(stop);
    }

    playShimmer(score, now) {
        const level = this.settings.layers.bells * .55 + this.settings.layers.field * .25;
        if (!level) return;
        const degree = score.chord[Math.floor(random01(this.settings.seed, score.step, 22) * score.chord.length)];
        const frequency = midiFrequency(score.rootMidi + 36 + degree);
        const gain = this.context.createGain();
        const highpass = this.context.createBiquadFilter();
        highpass.type = 'highpass'; highpass.frequency.value = 1100;
        gain.connect(highpass); this.connectVoice(highpass, random01(this.settings.seed, score.step, 23) * 1.8 - .9);
        const stop = this.envelope(gain, now, .012 * level, .6, .3, 4 + this.settings.space * 5);
        [1, 2.006, 3.998].forEach((ratio, index) => {
            const oscillator = this.track(this.context.createOscillator());
            const partialGain = this.context.createGain();
            oscillator.type = 'sine'; oscillator.frequency.value = frequency * ratio;
            partialGain.gain.value = 1 / (1 + index * 2.5);
            oscillator.connect(partialGain).connect(gain); oscillator.start(now); oscillator.stop(stop);
        });
    }

    async renderOffline({duration, startFrame, fps, timelineFrames = startFrame + Math.round(duration * fps), featureFrames, firstIndex = 0, onProgress = null, signal = null}) {
        const sampleRate = 48000;
        const sampleCount = Math.round(duration * sampleRate);
        const sampleOffset = Math.round(startFrame / fps * sampleRate);
        const totalSamples = Math.round(timelineFrames / fps * sampleRate);
        const renderDuration = totalSamples / sampleRate;
        if (firstIndex !== 0 || totalSamples < sampleOffset + sampleCount) {
            throw new Error('Soundtrack synthesis requires the complete timeline from frame zero');
        }
        const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!OfflineContext) throw new Error('This browser cannot render an offline soundtrack');
        signal?.throwIfAborted();
        // Always render the same complete timeline, including oscillator phases,
        // drones, note tails and effects history, then crop exact PCM. Keeping
        // the graph and render length identical also avoids Web Audio floating
        // point differences caused by rendering different-length prefixes.
        const context = new OfflineContext(2, totalSamples, sampleRate);
        const offline = new SpatialMusicEngine(null, () => {}, this.settings);
        offline.settings = normalizeSettings({...this.settings, enabled: true});
        offline.buildAudioGraph(context);
        const secondsPerStep = 60 / offline.settings.tempo / 4;
        // featureFrames[i] is analysis firstIndex + i on the shared loop-time timeline.
        const featuresAt = seconds => featureFrames[Math.min(featureFrames.length - 1,
            Math.max(0, analysisIndex(seconds) - firstIndex))];
        offline.features = featuresAt(0) || this.features;
        const finalStep = Math.floor((renderDuration - 1 / sampleRate) / secondsPerStep);
        offline.lastStep = 0;
        offline.rebuildSustains();

        // Scheduling the whole score up front stalls long exports: every note
        // node and automation event exists before rendering starts, with no
        // progress or cancellation until startRendering() resolves. Instead,
        // schedule a window ahead of the render and suspend between windows.
        const windowSeconds = 10;
        const lookahead = 2;
        let nextFeature = 0;
        let nextStep = 0;
        const scheduleUntil = horizon => {
            for (; nextFeature < featureFrames.length && (firstIndex + nextFeature) / 8 < horizon; nextFeature++) {
                const at = (firstIndex + nextFeature) / 8;
                offline.modulateSustains(at, featureFrames[nextFeature]);
            }
            for (; nextStep <= finalStep; nextStep++) {
                const eventTime = stepSeconds(nextStep, offline.settings.tempo);
                if (eventTime >= horizon) break;
                offline.features = featuresAt(stepSeconds(nextStep, offline.settings.tempo)) || offline.features;
                const score = compositionAt({seed: offline.settings.seed, step: nextStep, settings: offline.settings, features: offline.features});
                if (nextStep > 0 && nextStep % 16 === 0) offline.playHarmonicField(score, eventTime);
                if (score.pulse) offline.playUndertow(score, eventTime);
                if (score.bell) offline.playBell(score, eventTime);
                if (score.metal) offline.playMetal(score, eventTime);
                if (score.texture) offline.playTexture(score, eventTime);
                if (score.upper) offline.playShimmer(score, eventTime);
            }
        };
        scheduleUntil(windowSeconds + lookahead);
        // No clip-specific fade: a direct clip must equal the same PCM slice
        // of a longer export, including the final samples.
        let aborted = null;
        for (let at = windowSeconds; at < renderDuration; at += windowSeconds) {
            context.suspend(at).then(async () => {
                onProgress?.(at / renderDuration);
                // Let the page paint progress and handle a cancel click.
                await new Promise(resolve => setTimeout(resolve, 0));
                if (signal?.aborted) {
                    // Never resumed, so the render promise stays pending; the
                    // abort listener below rejects for it and the context is
                    // dropped for garbage collection.
                    aborted?.(signal.reason);
                    return;
                }
                scheduleUntil(at + windowSeconds + lookahead);
                context.resume();
            });
        }
        const rendered = await new Promise((resolve, reject) => {
            aborted = reject;
            signal?.addEventListener('abort', () => reject(signal.reason), {once: true});
            context.startRendering().then(resolve, reject);
        });
        onProgress?.(1);
        return {
            length: sampleCount,
            sampleRate,
            getChannelData: channel => rendered.getChannelData(channel).subarray(sampleOffset, sampleOffset + sampleCount)
        };
    }

    applyPreset(name) {
        const preset = PRESETS[name];
        if (!preset) return;
        this.settings = normalizeSettings({...this.settings, ...preset, preset: name, layers: {...preset.layers}});
        this.save();
        this.onStateChange?.();
        if (this.nodes) {
            this.nodes.convolver.buffer = this.createImpulse(5.8, this.settings.seed);
            this.updateMix();
            this.rebuildSustains();
        }
    }

    vary() {
        this.settings.seed = this.settings.seed % 999999 + 1;
        this.save();
        this.onStateChange?.();
        if (this.nodes) {
            this.nodes.convolver.buffer = this.createImpulse(5.8, this.settings.seed);
            this.lastStep = null;
            this.rebuildSustains();
        }
    }
}

async function sha256(value) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function audioBufferWav(buffer, onProgress = null) {
    const samples = buffer.length;
    const channels = 2;
    const pcmBytes = samples * channels * 2;
    const output = new ArrayBuffer(44 + pcmBytes);
    const view = new DataView(output);
    const text = (offset, value) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + pcmBytes, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, pcmBytes, true);
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    let offset = 44;
    for (let sample = 0; sample < samples; sample++) {
        for (const value of [left[sample], right[sample]]) {
            const limited = Math.max(-1, Math.min(1, value));
            view.setInt16(offset, limited < 0 ? Math.round(limited * 32768) : Math.round(limited * 32767), true);
            offset += 2;
        }
        if (sample && sample % 500000 === 0) {
            onProgress?.(sample / samples);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
    onProgress?.(1);
    return new Blob([output], {type: 'audio/wav'});
}

export function installVisualMusic({mount, canvas, sampleFrame = null, initialSettings = null, onStateChange = null, onPlaybackChange = null}) {
    const section = document.createElement('section');
    section.className = 'visual-music';
    section.innerHTML = `
        <details>
            <summary>Generative soundtrack <span class="music-live-dot" aria-hidden="true"></span></summary>
            <div class="music-body">
                <p class="music-intro">The final image drives a deterministic harmonic ecosystem. Headphones recommended.</p>
                <div class="music-actions"><button type="button" class="music-start">Start soundtrack</button><button type="button" class="music-stop" disabled>Stop</button></div>
                <label class="music-preset-label">Character<select class="music-preset"></select></label>
                <div class="music-macros"></div>
                <details class="music-layers"><summary>Layer mixer</summary><div></div></details>
                <div class="music-seed"><label>Variation <input type="number" min="1" max="999999"></label><button type="button">New variation</button></div>
                <div class="music-status" role="status">Sound is off.</div>
                <canvas class="music-meter" width="240" height="28" aria-label="Visual analysis meter"></canvas>
            </div>
        </details>`;
    mount.prepend(section);
    const status = section.querySelector('.music-status');
    const dot = section.querySelector('.music-live-dot');
    const engine = new SpatialMusicEngine(canvas, (message, state) => {
        status.textContent = message;
        status.classList.toggle('error', state === 'error');
        dot.classList.toggle('active', state === 'running');
    }, initialSettings, onStateChange);
    engine.sampleFrame = sampleFrame;
    const preset = section.querySelector('.music-preset');
    for (const [value, definition] of Object.entries(PRESETS)) {
        const option = document.createElement('option'); option.value = value; option.textContent = definition.label; preset.appendChild(option);
    }
    const customPreset = document.createElement('option');
    customPreset.value = 'custom'; customPreset.textContent = 'Custom'; customPreset.disabled = true;
    preset.appendChild(customPreset);
    preset.value = engine.settings.preset;
    const macroDefinitions = [
        ['level', 'Level', 0, 1, .01], ['density', 'Activity', 0, 1, .01], ['tension', 'Tension', 0, 1, .01],
        ['influence', 'Pixel influence', 0, 1, .01], ['space', 'Space', 0, 1, .01],
        ['tempo', 'Pulse', 36, 88, 1, value => `${Math.round(value)} BPM`]
    ];
    const controls = new Map();
    for (const [key, label, min, max, step, format] of macroDefinitions) {
        const control = makeSlider(`music-${key}`, label, engine.settings[key], min, max, step, format);
        controls.set(key, control); section.querySelector('.music-macros').appendChild(control.row);
    }
    for (const [key, value] of Object.entries(engine.settings.layers)) {
        const label = {drone: 'Substrate drones', field: 'Harmonic field', bells: 'Glass / FM bells', pulse: 'Undertow', metal: 'Inharmonic metal', texture: 'Filtered texture'}[key];
        const control = makeSlider(`music-layer-${key}`, label, value, 0, 1, .01);
        controls.set(`layer.${key}`, control); section.querySelector('.music-layers > div').appendChild(control.row);
    }
    const seed = section.querySelector('.music-seed input'); seed.value = String(engine.settings.seed);

    const refreshControls = () => {
        preset.value = engine.settings.preset;
        for (const [key, control] of controls) {
            const value = key.startsWith('layer.') ? engine.settings.layers[key.slice(6)] : engine.settings[key];
            control.input.value = String(value); control.output.value = control.format(value);
        }
        seed.value = String(engine.settings.seed);
    };
    preset.addEventListener('change', () => { engine.applyPreset(preset.value); refreshControls(); });
    for (const [key, control] of controls) {
        control.input.addEventListener('input', () => {
            const value = Number(control.input.value);
            if (key.startsWith('layer.')) engine.settings.layers[key.slice(6)] = value;
            else engine.settings[key] = value;
            control.output.value = control.format(value);
            engine.settings.preset = 'custom';
            engine.updateMix(); engine.modulateSustains(); engine.save(); engine.onStateChange?.();
        });
    }
    seed.addEventListener('change', () => {
        engine.settings.seed = Math.max(1, Math.min(999999, Math.trunc(Number(seed.value) || 1)));
        engine.save(); engine.rebuildSustains(); engine.onStateChange?.();
    });
    section.querySelector('.music-seed button').addEventListener('click', () => { engine.vary(); refreshControls(); });
    const start = section.querySelector('.music-start');
    const stop = section.querySelector('.music-stop');
    const setPlaying = playing => {
        start.disabled = playing; stop.disabled = !playing;
        onPlaybackChange?.(playing);
    };
    let pendingStart = null, cancelAutoplay = null;
    // Idempotent: while a start waits on autoplay, later gestures only unlock the context.
    const startSoundtrack = () => {
        if (pendingStart) { engine.context?.resume().catch(() => {}); return pendingStart; }
        pendingStart = (async () => {
            try {
                await engine.start(); setPlaying(true);
                return true;
            } catch (error) {
                status.textContent = error.message; status.classList.add('error');
                return false;
            } finally { pendingStart = null; }
        })();
        return pendingStart;
    };
    const stopSoundtrack = () => { cancelAutoplay?.(); engine.stop(); setPlaying(false); };
    start.addEventListener('click', startSoundtrack);
    stop.addEventListener('click', stopSoundtrack);

    const meter = section.querySelector('.music-meter');
    const meterContext = meter.getContext('2d');
    let meterFrame = 0;
    const drawMeter = () => {
        meterFrame = requestAnimationFrame(drawMeter);
        const features = engine.features;
        meterContext.fillStyle = '#090d13'; meterContext.fillRect(0, 0, meter.width, meter.height);
        features.regions.forEach((value, index) => {
            const x = index * 20;
            const hue = 205 + features.blue * 80 - features.red * 35;
            meterContext.fillStyle = `hsla(${hue},70%,${35 + value * 45}%,.9)`;
            meterContext.fillRect(x + 1, meter.height - value * meter.height, 18, value * meter.height);
        });
        meterContext.strokeStyle = '#d9e7f5'; meterContext.lineWidth = 1;
        const cx = features.centroidX * meter.width, cy = features.centroidY * meter.height;
        meterContext.beginPath(); meterContext.moveTo(cx - 4, cy); meterContext.lineTo(cx + 4, cy);
        meterContext.moveTo(cx, cy - 4); meterContext.lineTo(cx, cy + 4); meterContext.stroke();
    };
    drawMeter();
    const applySettings = value => {
        engine.settings = normalizeSettings({...engine.settings, ...value, layers: {...engine.settings.layers, ...value?.layers}});
        engine.analysisMemo.clear();
        engine.lastAnalysisIndex = null;
        engine.lastStep = null;
        engine.lastFrame = null;
        engine.save();
        refreshControls();
        engine.updateMix();
        if (engine.context && engine.settings.enabled) engine.rebuildSustains();
        setPlaying(false);
        status.textContent = engine.settings.enabled ? 'Soundtrack restored — click Start soundtrack to hear it.' : 'Sound is off.';
        dot.classList.remove('active');
    };
    if (engine.settings.enabled) status.textContent = 'Soundtrack restored — click Start soundtrack to hear it.';
    return Object.freeze({
        tick: state => engine.tick(state),
        get settings() { return structuredClone(engine.settings); },
        get defaultSettings() { return structuredClone(DEFAULTS); },
        setSettings: applySettings,
        get playing() { return !stop.disabled; },
        start: startSoundtrack,
        stop: stopSoundtrack,
        async requestAutoplay() {
            // iOS mutes Web Audio in silent mode unless the page declares media playback.
            try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* Optional. */ }
            // Browsers grant playback on different events: iOS and Chrome only
            // count a touch once it ends, so keep listening until a start succeeds.
            const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];
            const cleanup = cancelAutoplay = () => {
                cancelAutoplay = null;
                for (const type of GESTURES) window.removeEventListener(type, resume, true);
            };
            const resume = () => { startSoundtrack().then(started => { if (started) cleanup(); }); };
            // Install the gesture fallback before trying autoplay: some browsers
            // leave AudioContext.resume() pending rather than rejecting it.
            for (const type of GESTURES) window.addEventListener(type, resume, true);
            const attempt = startSoundtrack();
            attempt.then(started => { if (started) cleanup(); });
            const started = await Promise.race([
                attempt,
                new Promise(resolve => setTimeout(() => resolve(false), 250))
            ]);
            if (started) cleanup();
            else {
                status.textContent = 'Soundtrack autoplay is waiting for a click or key press.';
                status.classList.remove('error');
            }
        },
        async prepareExport({startFrame, frames, fps, timelineFrames = startFrame + frames, samplePixels, onProgress = null, signal = null}) {
            if (!engine.settings.enabled) return null;
            const duration = frames / fps;
            if (duration > 900) throw new Error('Generative soundtrack exports are currently limited to 15 minutes');
            // Analyze the same complete timeline for every export so synthesis and
            // effects history are independent of the selected clip window.
            const firstIndex = 0;
            const lastIndex = analysisIndex(timelineFrames / fps);
            const read = async index => {
                const pixels = await samplePixels(analysisFrame(index, fps));
                return [pixels.data, pixels.width, pixels.height];
            };
            const featureFrames = [];
            let previousLuma = firstIndex > 0 ? analyzeRGBA(...await read(firstIndex - 1)).luma : null;
            const analysisFrames = lastIndex - firstIndex + 1;
            for (let index = firstIndex; index <= lastIndex; index++) {
                signal?.throwIfAborted();
                const analysis = analyzeRGBA(...await read(index), previousLuma);
                previousLuma = analysis.luma;
                featureFrames.push(analysis.features);
                const done = index - firstIndex + 1;
                if (done % 16 === 1 || done === analysisFrames) {
                    onProgress?.({phase: 'analyze', progress: done / analysisFrames});
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            const settings = structuredClone(engine.settings);
            const scoreDocument = JSON.stringify({schema: 'spatial-reflections-music-v1', settings, startFrame, frames, fps,
                analysis: {rate: 8, firstIndex, render: 'chrome-grain-aging-v1'},
                synthesis: 'whole-timeline-v2', timelineFrames, featureFrames});
            const scoreHash = await sha256(scoreDocument);
            onProgress?.({phase: 'synthesize', progress: 0});
            const rendered = await engine.renderOffline({duration, startFrame, fps, timelineFrames, featureFrames, firstIndex, signal,
                onProgress: progress => onProgress?.({phase: 'synthesize', progress})});
            signal?.throwIfAborted();
            const wav = await audioBufferWav(rendered, progress => onProgress?.({phase: 'encode', progress}));
            signal?.throwIfAborted();
            return {
                wav,
                metadata: {
                    schema: 'spatial-reflections-music-v1', enabled: true,
                    sampleRate: 48000, channels: 2, samples: rendered.length,
                    settings, scoreHash,
                    analysisRender: 'chrome-grain-aging-v1', synthesis: 'whole-timeline-v2'
                }
            };
        },
        destroy() { cancelAnimationFrame(meterFrame); engine.stop(); engine.context?.close(); section.remove(); }
    });
}
