import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';

// Exercise the built production entry point, not the in-process test factory.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, ['server/dist/src/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
    ALLOWED_ORIGINS: 'http://tauri.localhost', TURN_URL: '', TURN_USERNAME: '', TURN_CREDENTIAL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr += String(chunk); });
const exited = once(child, 'exit');
try {
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, 'Production server exited prematurely');
    try { response = await fetch(`http://127.0.0.1:${port}/health`); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(response, 'Production server did not become healthy');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.equal(stderr, '', 'Unexpected server error output');
  console.log('PASS: built production server starts with validated origins; /health returned 200.');
} finally {
  child.kill();
  await exited;
}
