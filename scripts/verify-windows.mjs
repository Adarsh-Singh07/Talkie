import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const { version } = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
for (const [path, expectedMachine] of [
  ['src-tauri/target/release/talkie.exe', 0x8664],
  [`src-tauri/target/release/bundle/nsis/Talkie_${version}_x64-setup.exe`, 0x14c],
]) {
  const bytes = await readFile(path);
  const info = await stat(path);
  assert.equal(bytes.toString('ascii', 0, 2), 'MZ');
  const pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.toString('ascii', pe, pe + 4), 'PE\0\0');
  assert.equal(bytes.readUInt16LE(pe + 4), expectedMachine);
  console.log(JSON.stringify({ path, bytes: info.size, machine: expectedMachine === 0x8664 ? 'AMD64' : 'I386 NSIS bootstrapper (x64 payload)', sha256: createHash('sha256').update(bytes).digest('hex') }));
}
