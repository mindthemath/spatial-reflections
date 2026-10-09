/* Copyright 2026 Michael Pilosov. All rights reserved. */
// No Chromium or networking: exercise awaited server shutdown and cleanup bounds.
const { spawn } = require('child_process');
const assert = require('assert/strict');
const { bounded, stopServer, installCleanup } = require('./test_lifecycle.cjs');
(async () => {
  const child = spawn(process.execPath, ['-e', `
    process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),50));
    console.log('ready');setInterval(()=>{},1000);
  `]);
  child.stderr.resume();
  try {
    await bounded(new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);child.once('error', reject);
    }), 2000, 'Fixture startup');
    let calls=0;
    const cleanup=installCleanup(async()=>{calls++;await stopServer(child);});
    await Promise.all([cleanup(),cleanup()]);
    assert.equal(calls,1);
    assert.equal(child.exitCode,0,'Shutdown must await the server exit, not just send a signal');
    await stopServer(child); // already exited: idempotent
    await assert.rejects(bounded(new Promise(()=>{}),10,'injected wait'),/exceeded/);
    console.log('PASS: awaited test-server shutdown, idempotent cleanup, bounded waits.');
  } finally {
    if (child.exitCode===null && child.signalCode===null) {
      const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
