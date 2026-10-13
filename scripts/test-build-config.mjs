import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise the real Vite build entry point, not just the pure URL validator.
const require = createRequire(new URL('../client/package.json', import.meta.url));
const vite = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const cwd = fileURLToPath(new URL('../client', import.meta.url));
for (const [label, value] of [['missing/blank', ''], ['insecure', 'ws://127.0.0.1:8787'], ['local TLS', 'wss://localhost']]) {
  const result = spawnSync(process.execPath, [vite, 'build'], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_ENV: 'production', VITE_SIGNALING_URL: value },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, `${label} build must fail`);
  assert.match(result.stderr, /Signaling configuration error/);
  console.log(`PASS: ${label} production build rejected with actionable configuration error.`);
}
