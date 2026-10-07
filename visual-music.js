import {PRESETS, analyzeRGBA, compositionAt, hash32, midiFrequency, random01} from './visual-music-core.js';

const STORAGE_KEY = 'spatial-reflections.music-prototype.v1';
const DEFAULTS = {
    preset: 'cathedral', enabled: false, level: 0.72, seed: 1701,
    ...PRESETS.cathedral, layers: {...PRESETS.cathedral.layers}
};
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));
const lerp = (a, b, amount) => a + (b - a) * amount;
const dbGain = db => Math.pow(10, db / 20);

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        return normalizeSettings({...DEFAULTS, ...saved, layers: {...DEFAULTS.layers, ...saved?.layers}, enabled: false});
    } catch {
        return normalizeSettings(DEFAULTS);
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
    constructor(canvas, onStatus) {
        this.canvas = canvas;
        this.onStatus = onStatus;
        this.settings = loadSettings();
        this.context = null;
        this.nodes = null;
        this.previousLuma = null;
        this.features = {luminance: .15, contrast: .2, edge: .1, motion: 0, red: .33, green: .33, blue: .34,
            centroidX: .5, centroidY: .5, balance: .5, regions: Array(12).fill(.15)};
        this.analysisCanvas = document.createElement('canvas');
        this.analysisCanvas.width = 48;
        this.analysisCanvas.height = 27;
        this.analysisContext = this.analysisCanvas.getContext('2d', {willReadFrequently: true, alpha: false});
        this.lastAnalysisBucket = null;
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
        this.lastStep = null;
        this.rebuildSustains();
        this.updateMix();
        this.onStatus('Listening to the framebuffer… play the geometry to drive events.', 'running');
    }

    stop() {
        this.settings.enabled = false;
        this.releaseSustains(1.2);
        if (this.nodes && this.context) setParam(this.nodes.master.gain, 0.0001, this.context.currentTime, .18);
        this.onStatus('Soundtrack stopped.', 'idle');
    }

    buildAudioGraph() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('This browser does not provide Web Audio');
        const context = this.context = new AudioContextClass({latencyHint: 'interactive'});
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

    analyze() {
        try {
            const context = this.analysisContext;
            context.drawImage(this.canvas, 0, 0, 48, 27);
            const image = context.getImageData(0, 0, 48, 27);
            const analysis = analyzeRGBA(image.data, 48, 27, this.previousLuma);
            this.previousLuma = analysis.luma;
            this.features = analysis.features;
            return true;
        } catch (error) {
            this.onStatus(`Pixel analysis unavailable: ${error.message}`, 'error');
            return false;
        }
    }

    tick({frame, fps, paused}) {
        if (!this.settings.enabled || !this.context || this.context.state !== 'running') return;
        const framesPerAnalysis = Math.max(1, Math.round(fps / 8));
        const analysisBucket = Math.floor(frame / framesPerAnalysis);
        if (analysisBucket !== this.lastAnalysisBucket) {
            this.lastAnalysisBucket = analysisBucket;
            this.analyze();
            this.modulateSustains();
        }
        const visualSeconds = frame / fps;
        const step = Math.floor(visualSeconds * this.settings.tempo / 60 * 4);
        const discontinuity = this.lastFrame !== null && Math.abs(frame - this.lastFrame) > Math.max(4, fps / 2);
        if (discontinuity || step < (this.lastStep ?? step)) {
            this.lastStep = null;
            this.releaseSustains(.8);
            this.rebuildSustains();
        }
        this.lastFrame = frame;
        if (paused || step === this.lastStep) return;
        // Do not fire a backlog after hidden-tab throttling or a timeline seek.
        this.lastStep = step;
        this.performStep(step);
    }

    performStep(step) {
        const now = this.context.currentTime + .018;
        const score = compositionAt({seed: this.settings.seed, step, settings: this.settings, features: this.features});
        const previous = this.lastComposition;
        this.lastComposition = score;
        if (!previous || previous.bar !== score.bar) this.playHarmonicField(score, now);
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

    modulateSustains() {
        if (!this.context) return;
        const now = this.context.currentTime;
        const influence = this.settings.influence;
        const luminance = lerp(.24, this.features.luminance, influence);
        const contrast = lerp(.18, this.features.contrast, influence);
        const edge = lerp(.12, this.features.edge, influence);
        const centroidX = lerp(.5, this.features.centroidX, influence);
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

    applyPreset(name) {
        const preset = PRESETS[name];
        if (!preset) return;
        this.settings = normalizeSettings({...this.settings, ...preset, preset: name, layers: {...preset.layers}});
        this.save();
        if (this.nodes) {
            this.nodes.convolver.buffer = this.createImpulse(5.8, this.settings.seed);
            this.updateMix();
            this.rebuildSustains();
        }
    }

    vary() {
        this.settings.seed = this.settings.seed % 999999 + 1;
        this.save();
        if (this.nodes) {
            this.nodes.convolver.buffer = this.createImpulse(5.8, this.settings.seed);
            this.lastStep = null;
            this.rebuildSustains();
        }
    }
}

export function installVisualMusic({mount, canvas}) {
    const section = document.createElement('section');
    section.className = 'visual-music';
    section.innerHTML = `
        <details open>
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
    });
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
            engine.updateMix(); engine.modulateSustains(); engine.save();
        });
    }
    seed.addEventListener('change', () => {
        engine.settings.seed = Math.max(1, Math.min(999999, Math.trunc(Number(seed.value) || 1)));
        engine.save(); engine.rebuildSustains();
    });
    section.querySelector('.music-seed button').addEventListener('click', () => { engine.vary(); refreshControls(); });
    const start = section.querySelector('.music-start');
    const stop = section.querySelector('.music-stop');
    start.addEventListener('click', async () => {
        try {
            await engine.start(); start.disabled = true; stop.disabled = false;
        } catch (error) {
            status.textContent = error.message; status.classList.add('error');
        }
    });
    stop.addEventListener('click', () => { engine.stop(); start.disabled = false; stop.disabled = true; });

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
    return Object.freeze({
        tick: state => engine.tick(state),
        get settings() { return structuredClone(engine.settings); },
        stop: () => engine.stop(),
        destroy() { cancelAnimationFrame(meterFrame); engine.stop(); engine.context?.close(); section.remove(); }
    });
}
