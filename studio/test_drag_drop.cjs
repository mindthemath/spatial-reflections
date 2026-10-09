/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Event/timer regression checks: no browser, server or encoder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'tesseract.js'), 'utf8');
const handlers = source.slice(source.indexOf('function setupDragAndDropHandlers()'), source.indexOf('// Create a visual drop zone'));
function fixture() {
    const listeners = {}, timers = new Map(), loaded = [], alerts = [];
    const overlay = {style: {display: 'none'}};
    let nextTimer = 0;
    const window = {innerWidth: 800, innerHeight: 600, addEventListener(type, callback) {listeners[type] = callback;}};
    const document = {hidden: false, getElementById() {return overlay;}, addEventListener(type, callback) {listeners[type] = callback;}};
    vm.runInNewContext(`${handlers};setupDragAndDropHandlers();`, {
        window, document,
        setTimeout(callback, delay) {assert.equal(delay, 1200);timers.set(++nextTimer, callback);return nextTimer;},
        clearTimeout(id) {timers.delete(id);},
        readMetadataFromPNG(file) {loaded.push(file);}, alert(message) {alerts.push(message);}
    });
    const emit = (type, extra = {}) => listeners[type]({clientX: 200, clientY: 200, preventDefault() {}, stopPropagation() {}, ...extra});
    const start = () => {emit('dragenter');emit('dragover');assert.equal(overlay.style.display, 'block');};
    const hidden = () => {assert.equal(overlay.style.display, 'none');assert.equal(timers.size, 0);};
    return {overlay, timers, loaded, alerts, document, emit, start, hidden};
}
// Exit can report stale, interior coordinates; body bounds are irrelevant.
{
    const f = fixture();f.start();f.emit('dragleave');f.hidden();
}
// Child transitions must not dismiss a drag still inside the viewer.
{
    const f = fixture();f.start();f.emit('dragenter');f.emit('dragleave');
    assert.equal(f.overlay.style.display, 'block');
    f.emit('dragleave');f.hidden();
}
// Viewport exit cleans up even if a nested enter was not balanced.
{
    const f = fixture();f.start();f.emit('dragenter');f.emit('dragleave', {clientY: 601});f.hidden();
}
for (const type of ['dragend', 'blur', 'keydown', 'visibilitychange']) {
    const f = fixture();f.start();f.document.hidden = true;f.emit(type, {key: 'Escape'});f.hidden();
}
// Lost OS cancellation events cannot leave the overlay stuck indefinitely.
{
    const f = fixture();f.start();const first = [...f.timers.keys()][0];
    f.emit('dragover');assert(!f.timers.has(first));assert.equal(f.timers.size, 1);
    [...f.timers.values()][0]();f.hidden();
}
// Dropping still loads PNGs and clears the fallback timer, even without enter.
{
    const f = fixture();const png = {type: 'image/png'};f.start();
    f.emit('drop', {dataTransfer: {files: [png]}});f.hidden();assert.deepEqual(f.loaded, [png]);
    f.emit('drop', {dataTransfer: {files: []}});f.hidden();
    f.start();f.emit('drop', {dataTransfer: {files: [{type: 'text/plain'}]}});f.hidden();assert.equal(f.alerts.length, 1);
}
console.log('PASS: cancelled drags clear the overlay; nested drags and PNG drops still work.');
