import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveSignalingConfig } from '../client/src/lib/config.ts';
import { SignalingClient } from '../client/src/lib/signaling.ts';

// Uses ONLY a verified operator-supplied public endpoint. No discovery or TLS bypass.
const config = resolveSignalingConfig(process.env.VITE_SIGNALING_URL, false);
if (!config.ok) throw new Error(config.error);
const health = new URL(config.url);
health.protocol = 'https:'; health.pathname = '/health'; health.search = '';
const response = await fetch(health, { redirect: 'error', signal: AbortSignal.timeout(15000) });
assert.equal(response.status, 200, 'Health endpoint must return 200');
assert.deepEqual(await response.json(), { status: 'ok' });
console.log('PASS: public HTTPS health with certificate verification.');

const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws');
function participant() {
  const events = [];
  const client = new SignalingClient(config.url, url => new WebSocket(url, {
    origin: 'http://tauri.localhost', handshakeTimeout: 15000,
  }));
  client.on(event => { events.push(event); if (event.type === 'room') client.ready(); });
  return { client, events };
}
const a = participant(); const b = participant();
async function until(predicate, operation) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if ([...a.events, ...b.events].some(event => event.type === 'error')) throw new Error(`Public signaling error during ${operation}; inspect safe server status, not credential payloads.`);
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out during ${operation}`);
}
try {
  a.client.create();
  await until(() => a.events.some(event => event.type === 'room'), 'room creation');
  const room = a.events.find(event => event.type === 'room');
  b.client.join(room.roomCode, room.invitationToken);
  await until(() => a.client.currentEpoch && b.client.currentEpoch === a.client.currentEpoch, 'room joining and ready barrier');
  a.client.sendSignal('offer', 'Talkie protocol-only network probe; not audio SDP');
  await until(() => b.events.some(event => event.type === 'signal' && event.kind === 'offer'), 'offer relay');
  const id = a.client.requestFloor();
  await until(() => a.events.some(event => event.type === 'floor_granted' && event.id === id), 'floor grant');
  const grant = a.events.find(event => event.type === 'floor_granted' && event.id === id);
  a.client.releaseFloor(grant.leaseId);
  await until(() => b.events.some(event => event.type === 'floor_released' && event.leaseId === grant.leaseId), 'floor release');
  console.log('PASS: WSS handshake with Windows origin, create/join, negotiation metadata and floor control.');

  const issued = [...a.events, ...b.events].filter(event => event.type === 'room').flatMap(event => event.iceServers ?? []);
  const turn = issued.filter(server => /^turns?:/.test(String(server.urls)));
  if (process.argv.includes('--require-turn')) assert.ok(turn.length > 0, 'TURN credentials required but not issued');
  for (const server of turn) {
    assert.match(server.username ?? '', /^\d+:[0-9a-f]{32}$/, 'Expected temporary TURN username');
    const ttl = Number(server.username.split(':')[0]) - Math.floor(Date.now() / 1000);
    assert.ok(ttl > 0 && ttl <= 86400, 'TURN expiry must be in the bounded future');
    assert.match(server.credential ?? '', /^[A-Za-z0-9+/]{27}=$/, 'Expected HMAC-SHA1 base64 credential');
  }
  console.log(turn.length ? 'PASS: temporary TURN credential structure/expiry received after room admission (not relay allocation).' : 'TURN: not configured; STUN/direct-only signaling test.');
  console.log('NOT TESTED: real audio, WebView2 permissions, TURN allocation, restrictive-network connectivity, and Windows hotkeys.');
} finally {
  a.client.disconnect(); b.client.disconnect();
}
