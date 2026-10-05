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
    await page.addScriptTag({ content: `let videoCaptureSurface=null,videoCaptureContext=null;let renderer,scene,camera;${helpers}` });
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
      OffscreenCanvas.prototype.convertToBlob=async function(){ctx.clearRect(0,0,128,72);throw new Error('injected encoder failure');};
      let fallback;
      try { fallback=await canvasPNG(canvas); } finally { OffscreenCanvas.prototype.convertToBlob=original; }
      return {first:await read(first),second:await read(second),fallback:await read(fallback),rerenders};
    });
    assert.deepEqual(result.first,[255,0,0,255]);
    assert.deepEqual(result.second,[0,255,0,255]);
    assert.deepEqual(result.fallback,[0,0,255,255]);
    assert.equal(result.rerenders,1);
    console.log('PASS: offscreen capture preserves pixels, reuses surface, and redraws on fallback.');
  } finally { await cleanup(); }
})().catch(error => { console.error(error);process.exitCode=1; });
