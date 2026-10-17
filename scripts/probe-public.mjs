import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolveSignalingConfig } from '../client/src/lib/config.ts';
import { SignalingClient } from '../client/src/lib/signaling.ts';

// Uses ONLY a verified operator-supplied public endpoint. No discovery or TLS bypass.
const config = resolveSignalingConfig(process.env.VITE_SIGNALING_URL, false);
if (!config.ok) throw new Error(config.error);
const cloudflareKeyId = process.env.CF_TURN_KEY_ID?.trim();
const cloudflareApiToken = process.env.CF_TURN_API_TOKEN?.trim();
const cloudflareTurnUrls = new Set([
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
]);
const isCloudflareTurnUrl = url => /^turns?:turn\.cloudflare\.com:/i.test(url);
if (Boolean(cloudflareKeyId) !== Boolean(cloudflareApiToken)) {
  throw new Error('Cloudflare TURN probe credentials must be supplied together; no credential value is logged.');
}
if (cloudflareKeyId && (cloudflareKeyId.length > 512 || cloudflareApiToken.length > 4096)) {
  throw new Error('Cloudflare TURN probe credentials exceed the supported bounds; no credential value is logged.');
}
const health = new URL(config.url);
health.protocol = 'https:'; health.pathname = '/health'; health.search = '';
const response = await fetch(health, { redirect: 'error', signal: AbortSignal.timeout(15000) });
assert.equal(response.status, 200, 'Health endpoint must return 200');
assert.deepEqual(await response.json(), { status: 'ok' });
console.log('PASS: public HTTPS health with certificate verification.');

async function validateCloudflareTurnCredentials() {
  if (!cloudflareKeyId || !cloudflareApiToken) return;
  // This validates only the operator-supplied Cloudflare credentials and the
  // returned ICE shape. Never print the request, token, response body, or URLs.
  const cloudflare = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cloudflareKeyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${cloudflareApiToken}` },
    body: JSON.stringify({ ttl: 86400 }),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(cloudflare.status, 200, 'Cloudflare TURN credential validation must return 200');
  let body;
  try { body = await cloudflare.json(); } catch { throw new Error('Cloudflare TURN credential validation returned invalid JSON.'); }
  const entries = body && typeof body === 'object' && Array.isArray(body.iceServers) ? body.iceServers : [];
  const turnEntries = entries.filter(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    return urls.some(url => typeof url === 'string' && /^turns?:/i.test(url))
      && typeof entry.username === 'string' && entry.username.length > 0
      && typeof entry.credential === 'string' && entry.credential.length > 0;
  });
  assert.ok(turnEntries.length > 0, 'Cloudflare TURN credential validation returned no credentialed TURN entries');
  console.log('PASS: Cloudflare TURN credentials accepted and credentialed ICE entries returned (allocation not tested).');
}

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
  const turn = issued.filter(server => /^turns?:/i.test(String(server.urls)));
  if (process.argv.includes('--require-turn')) assert.ok(turn.length > 0, 'TURN credentials required but not issued');
  if (cloudflareKeyId) assert.ok(turn.length > 0, 'Cloudflare TURN credentials supplied but the public room did not issue a TURN entry');
  const cloudflareTurn = turn.filter(server => cloudflareTurnUrls.has(String(server.urls)));
  if (cloudflareTurn.length) {
    assert.deepEqual(new Set(cloudflareTurn.map(server => server.urls)), cloudflareTurnUrls, 'Cloudflare TURN transport set is incomplete');
    assert.ok(cloudflareTurn.every(server => typeof server.username === 'string' && server.username.length > 0 && typeof server.credential === 'string' && server.credential.length > 0), 'Cloudflare TURN credentials missing from the public room');
  }
  for (const server of turn) {
    if (/^\d+:[0-9a-f]{32}$/.test(server.username ?? '')) {
      const ttl = Number(server.username.split(':')[0]) - Math.floor(Date.now() / 1000);
      assert.ok(ttl > 0 && ttl <= 86400, 'TURN expiry must be in the bounded future');
      assert.match(server.credential ?? '', /^[A-Za-z0-9+/]{27}=$/, 'Expected HMAC-SHA1 base64 credential');
    } else if (cloudflareKeyId || isCloudflareTurnUrl(String(server.urls))) {
      // Cloudflare credentials have a provider-defined username/credential
      // shape. Their authorization and ICE shape are validated separately.
      assert.ok(typeof server.username === 'string' && server.username.length > 0, 'Cloudflare TURN username missing');
      assert.ok(typeof server.credential === 'string' && server.credential.length > 0, 'Cloudflare TURN credential missing');
    } else {
      assert.fail('Unexpected TURN credential shape; supply both Cloudflare probe variables to validate provider-defined credentials.');
    }
  }
  console.log(turn.length ? 'PASS: temporary TURN credential structure/expiry received after room admission (not relay allocation).' : 'TURN: not configured; STUN/direct-only signaling test.');
  await validateCloudflareTurnCredentials();
  console.log('NOT TESTED: real audio, WebView2 permissions, TURN allocation, restrictive-network connectivity, and Windows hotkeys.');
} finally {
  a.client.disconnect(); b.client.disconnect();
}
