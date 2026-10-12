/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Web Audio regression: real offline synthesis, no server, assets or encoder.
const {ensureGuard, bounded, installCleanup} = require('./test_lifecycle.cjs');
ensureGuard(__filename, {timeout:120});
const {chromium} = require('playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), vm = require('node:vm');
const viewerSource = fs.readFileSync(path.join(__dirname,'../tesseract.js'),'utf8');
const frameCode = viewerSource.slice(viewerSource.indexOf('function setTimelineFrame('),viewerSource.indexOf('function formatDuration('));
const uiCode = viewerSource.slice(viewerSource.indexOf('function updateLoopTimingUI('),viewerSource.indexOf('// Master is content-dependent'));
const frameContext = {timelineFrame:0,time:0,loopTiming:{frameCount:25133,timeStep:.005},
 timelineSlider:null,timelineFrameDisplay:{},timelineFrameInput:{},loopInfoDisplay:null};
vm.runInNewContext(`${frameCode}\n${uiCode}`,frameContext);
frameContext.setTimelineFrame(10900);
assert.equal(frameContext.timelineFrame,10900);
assert.equal(frameContext.timelineFrameInput.value,'10900');
assert.equal(frameContext.timelineFrameDisplay.textContent,'Frame 10900 / 25132');
frameContext.setTimelineFrame(0);assert.equal(frameContext.timelineFrameInput.value,'0');
console.log('PASS: timeline UI and saved frames use the same zero-based index.');
(async () => {
 let browser;
 const cleanup = installCleanup(async () => { if (browser) await bounded(browser.close(),10000,'Chromium shutdown'); });
 try {
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const core = fs.readFileSync(path.join(__dirname,'../visual-music-core.js'),'utf8').replace(/^export /gm,'');
  const music = fs.readFileSync(path.join(__dirname,'../visual-music.js'),'utf8');
  const engineSource = music.slice(music.indexOf('const STORAGE_KEY'),music.indexOf('async function sha256'));
  await page.addScriptTag({content:`${core}\n${engineSource}\nwindow.Engine=SpatialMusicEngine;window.presets=PRESETS;`});
  const result = await page.evaluate(async () => {
   const engine = new window.Engine(null,()=>{}, {preset:'abyssdrive',...window.presets.abyssdrive,enabled:true,seed:1701});
   // Exercise every voice, including field tails, and feedback/reverb history.
   engine.settings.layers = {drone:1,field:.7,bells:.8,pulse:.9,metal:.3,texture:.4};
   engine.settings.space=.7; engine.settings.density=.8;
   const features = Array.from({length:225},(_,i)=>({...engine.features,
    luminance:.2+(i%11)/30,motion:(i%7)/20,edge:(i%5)/10,
    regions:Array.from({length:12},(_,k)=>((i+k)%13)/13)}));
   const full = await engine.renderOffline({duration:28,startFrame:0,fps:30,featureFrames:features});
   const startFrame=341, frames=270, startSample=startFrame*1600;
   const clip = await engine.renderOffline({duration:frames/30,startFrame,fps:30,
    timelineFrames:840,featureFrames:features});
   let maxError=0,mismatches=0;
   for(let c=0;c<2;c++) {
    const a=full.getChannelData(c),b=clip.getChannelData(c);
    for(let i=0;i<b.length;i++) {const error=Math.abs(a[startSample+i]-b[i]);maxError=Math.max(maxError,error);if(error>0)mismatches++;}
   }
   // Startup, paused unmute and seeks must not replay an event at the current step.
   const live = new window.Engine(null,()=>{},engine.settings);
   live.context={state:'running',currentTime:0};live.analyzeAt=()=>live.features;
   live.modulateSustains=()=>{};live.releaseSustains=()=>{};live.rebuildSustains=()=>{};
   const steps=[];live.performStep=step=>steps.push(step);
   live.tick({frame:10900,fps:30,paused:true});
   live.tick({frame:10900,fps:30,paused:false});
   const afterUnmute=steps.length;
   live.tick({frame:10905,fps:30,paused:false});
   const afterCrossing=steps.length;
   live.tick({frame:5599,fps:30,paused:false});
   const afterSeek=steps.length;
   const fields=[];
   engine.context={currentTime:0};engine.analyzeAt=()=>engine.features;
   engine.playHarmonicField=score=>fields.push(score.step);
   for(const name of ['playUndertow','playBell','playMetal','playTexture','playShimmer']) engine[name]=()=>{};
   for(const step of [0,7,16,19,32]) engine.performStep(step,30);
   return {maxError,mismatches,length:clip.length,afterUnmute,afterCrossing,afterSeek,fields};
  });
  // Web Audio's multithreaded convolution can vary by a few float ULPs
  // between independent contexts. Require agreement far below one 16-bit LSB.
  assert(result.maxError < 1e-6,`cropped/direct PCM error ${result.maxError}`);
  assert.equal(result.length,432000);
  assert.equal(result.afterUnmute,0);assert.equal(result.afterCrossing,1);assert.equal(result.afterSeek,1);
  assert.deepEqual(result.fields,[16,32],'harmonic fields only fire on actual bar boundaries, not startup');
  console.log('PASS: cropped/direct soundtrack agrees below 1 PCM LSB, no startup/seek attack, canonical bar events.');
 } finally { await cleanup(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
