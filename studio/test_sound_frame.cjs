/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Sound-frame sizing and the hidden ?soundframe= argument: no browser needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'tesseract.js'), 'utf8');
const start = source.indexOf('function soundAnalysisSize(');
const helpers = source.slice(start, source.indexOf('const soundFrameAspect', start));
const context = {URLSearchParams};
vm.runInNewContext(`${helpers};this.soundAnalysisSize=soundAnalysisSize;this.parseSoundFrame=parseSoundFrame;`, context);
const {soundAnalysisSize, parseSoundFrame} = context;

// Same frame the export has always analyzed: 64 px wide, aspect sets the height.
assert.deepEqual({...soundAnalysisSize(16 / 9)}, {width: 64, height: 36});
assert.deepEqual({...soundAnalysisSize(1)}, {width: 64, height: 64});
assert.deepEqual({...soundAnalysisSize(9 / 16)}, {width: 64, height: 64}, 'portrait clamps to square');
assert.deepEqual({...soundAnalysisSize(21 / 9)}, {width: 64, height: 27});
assert.deepEqual({...soundAnalysisSize(4)}, {width: 64, height: 24}, 'very wide clamps to 24 rows');

// Resolution names only choose an aspect: every 16:9 resolution sounds the same.
for (const name of ['1080p', '720p', '1440p', '4K', '4k']) assert.equal(parseSoundFrame(`?soundframe=${name}`), 16 / 9, name);
assert.equal(parseSoundFrame('?soundframe=square'), 1);
assert.equal(parseSoundFrame('?soundframe=16:9'), 16 / 9);
assert.equal(parseSoundFrame('?soundframe=1920x1080'), 16 / 9);
assert.equal(parseSoundFrame('?soundframe=2.39:1'), 2.39);
assert.equal(parseSoundFrame('?skybox=exports/x&soundframe=SQUARE'), 1, 'case-insensitive alongside other arguments');
for (const search of ['', '?soundframe=', '?soundframe=0:9', '?soundframe=wide', '?soundframe=16:', '?soundframe=constructor']) {
    assert.equal(parseSoundFrame(search), null, search || 'absent');
}
console.log('PASS: sound frames keep export sizing; ?soundframe= maps names and ratios to aspects.');

const overrideSource = source.slice(source.indexOf('function withSoundAnalysisMaterial('), source.indexOf('function sampleLiveSoundFrame('));
const previousMaterial = {};
const renderContext = {soundAnalysisMaterial:null, scene:{overrideMaterial:previousMaterial}, envMap:{},
 currentShape:'tesseract',currentLighting:'diagonal',lightDistance:.1,
 createShaderMaterial(shader) {
  assert.equal(shader,'chrome');
  return {uniforms:Object.fromEntries(['envMap','surfaceGrain','dirtyMirrors','faceSides','lightDistance','lightingType'].map(key=>[key,{value:0}]))};
 }};
vm.runInNewContext(`${overrideSource};this.withSoundAnalysisMaterial=withSoundAnalysisMaterial;`,renderContext);
renderContext.withSoundAnalysisMaterial(()=>{
 const uniforms=renderContext.scene.overrideMaterial.uniforms;
 assert.equal(uniforms.surfaceGrain.value,1);assert.equal(uniforms.dirtyMirrors.value,1);
 assert.equal(uniforms.faceSides.value,4);
});
assert.equal(renderContext.scene.overrideMaterial,previousMaterial);
assert.throws(()=>renderContext.withSoundAnalysisMaterial(()=>{throw new Error('capture failed');}),/capture failed/);
assert.equal(renderContext.scene.overrideMaterial,previousMaterial,'restore visible material even after capture failure');
console.log('PASS: music always analyzes chrome/grain/aging, with exception-safe visible material restoration.');
