/* Copyright 2026 Michael Pilosov. All rights reserved. */
// Common lifecycle helpers. Direct test-file execution also uses the shared guard.
const { spawnSync } = require('child_process');
function ensureGuard(file, { network = false, timeout = 300 } = {}) {
  if (process.env.TESSERACT_TEST_GUARD_TOKEN) return;
  const result = spawnSync('python3', [require('path').join(__dirname, '..', 'scripts', 'test_guard.py'),
    '--timeout', String(timeout), ...(network ? ['--network'] : []), '--', process.execPath, file],
    { stdio: 'inherit' });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 2);
}
async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds / 1000}s`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function stopServer(server) {
  if (!server.pid || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  try { await bounded(exited, 5000, 'Test server shutdown'); }
  catch {
    server.kill('SIGKILL');
    await bounded(exited, 5000, 'Forced test server shutdown');
  }
}
function installCleanup(action) {
  let promise;
  const cleanup = () => promise ||= Promise.resolve().then(action);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => {
      cleanup().catch(error => console.error(error)).finally(() => process.exit(code));
    });
  }
  return cleanup;
}
module.exports = { ensureGuard, bounded, stopServer, installCleanup };
