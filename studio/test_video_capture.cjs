/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Isolated capture regression: no HTTP server, skyboxes, or ffmpeg processes.
const { ensureGuard, bounded, installCleanup } = require('./test_lifecycle.cjs');
ensureGuard(__filename, { timeout: 60 });
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
(async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'tesseract.js'), 'utf8');
  const helpers = source.slice(source.indexOf('function dataUrlToBlob('), source.indexOf('function screenshotMetadata('));
  let browser;
  const cleanup = installCleanup(async () => {
    if (browser) await bounded(browser.close(), 10000, 'Chromium shutdown');
  });
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.addScriptTag({ content: `let videoCaptureSurface=null,videoCaptureContext=null,videoCaptureFallback=false;let renderer,scene,camera;${helpers}` });
    const result = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 72;
      const ctx = canvas.getContext('2d');
      const paint = color => { ctx.fillStyle=color;ctx.fillRect(0,0,128,72); };
      const read = async blob => {
        const bitmap = await createImageBitmap(blob);
        const surface = new OffscreenCanvas(128,72);
        const context = surface.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();
        return Array.from(context.getImageData(20,20,1,1).data);
      };
      paint('#ff0000');const first = await canvasPNG(canvas);
      paint('#00ff00');const second = await canvasPNG(canvas);
      let rerenders=0;
      renderer={render(){rerenders++;paint('#0000ff');}};
      const original = OffscreenCanvas.prototype.convertToBlob;
      let failureCalls=0;
      OffscreenCanvas.prototype.convertToBlob=async function(){failureCalls++;ctx.clearRect(0,0,128,72);throw new Error('injected encoder failure');};
      let fallback,sticky;
      try {
        fallback=await canvasPNG(canvas);paint('#ff00ff');sticky=await canvasPNG(canvas);
      } finally { OffscreenCanvas.prototype.convertToBlob=original; }
      const failureRerenders=rerenders;
      // Advance only the capture timeout: no actual 30-second wait or encoder.
      videoCaptureFallback=false;videoCaptureSurface=videoCaptureContext=null;
      let timeoutCalls=0;
      const setTimer=window.setTimeout;
      window.setTimeout=(fn,delay,...args)=>setTimer(fn,delay===30000?0:delay,...args);
      OffscreenCanvas.prototype.convertToBlob=()=>{timeoutCalls++;return new Promise(()=>{});};
      let timedOut,afterTimeout;
      try {
        timedOut=await canvasPNG(canvas);paint('#00ff00');afterTimeout=await canvasPNG(canvas);
      } finally {window.setTimeout=setTimer;OffscreenCanvas.prototype.convertToBlob=original;}
      return {first:await read(first),second:await read(second),fallback:await read(fallback),sticky:await read(sticky),timedOut:await read(timedOut),afterTimeout:await read(afterTimeout),failureRerenders,failureCalls,timeoutCalls,rerenders};
    });
    assert.deepEqual(result.first,[255,0,0,255]);
    assert.deepEqual(result.second,[0,255,0,255]);
    assert.deepEqual(result.fallback,[0,0,255,255]);
    assert.deepEqual(result.sticky,[255,0,255,255]);
    assert.deepEqual(result.timedOut,[0,0,255,255]);
    assert.deepEqual(result.afterTimeout,[0,255,0,255]);
    assert.equal(result.failureRerenders,1);assert.equal(result.rerenders,2);
    assert.equal(result.failureCalls,1);assert.equal(result.timeoutCalls,1);
    console.log('PASS: capture preserves pixels, reuses surface, and makes failure/timeout fallback sticky.');
  } finally { await cleanup(); }
})().catch(error => { console.error(error);process.exitCode=1; });
