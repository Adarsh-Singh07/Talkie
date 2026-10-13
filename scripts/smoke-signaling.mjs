import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSignalingServer } from '../server/src/server.ts';
import { SignalingClient } from '../client/src/lib/signaling.ts';

const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws');
const server = createSignalingServer({ heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 5000 });
await server.listen(0);
const url = `ws://127.0.0.1:${server.server.address().port}`;
function participant() {
  const sockets = []; const events = [];
  const client = new SignalingClient(url, address => { const socket = new WebSocket(address); sockets.push(socket); return socket; });
  client.on(event => { events.push(event); if (event.type === 'room') client.ready(); });
  return { client, sockets, events };
}
async function until(predicate, description) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}`);
}
const a = participant(); const b = participant();
try {
  a.client.create();
  await until(() => a.events.some(event => event.type === 'room'), 'create');
  const room = a.events.find(event => event.type === 'room');
  b.client.join(room.roomCode, room.invitationToken);
  await until(() => a.client.currentEpoch === 1 && b.client.currentEpoch === 1, 'initial ready barrier');
  a.client.sendSignal('offer', 'contract-test-sdp');
  await until(() => b.events.some(event => event.type === 'signal' && event.payload === 'contract-test-sdp'), 'offer relay');
  const request = a.client.requestFloor();
  await until(() => a.events.some(event => event.type === 'floor_granted' && event.id === request), 'matching grant');
  const grant = a.events.find(event => event.type === 'floor_granted' && event.id === request);
  assert.equal(grant.epoch, 1); assert.equal(grant.leaseDurationMs, 30000);
  a.client.speaking(grant.leaseId, true);
  await until(() => b.events.some(event => event.type === 'speaking' && event.speaking), 'speaking relay');

  // Drop the other participant while a holds the floor. Remaining a is refreshed
  // by the token-less joined ack, while b privately resumes its own identity.
  b.sockets.at(-1).terminate();
  await until(() => a.events.some(event => event.type === 'peer_left'), 'peer disconnect');
  await until(() => a.client.currentEpoch === 2 && b.client.currentEpoch === 2, 'one-peer resume');
  assert.equal(a.client.currentGeneration, 1); assert.equal(b.client.currentGeneration, 2);
  assert.equal(server.manager.get(room.roomCode).floor, undefined);

  // Both lose signaling; their resume credentials must survive and epochs must
  // continue rather than restarting at one or resurrecting the prior floor.
  a.sockets.at(-1).terminate(); b.sockets.at(-1).terminate();
  await until(() => a.client.currentGeneration === 2 && b.client.currentGeneration === 3 && a.client.currentEpoch === 3 && b.client.currentEpoch === 3, 'both-peer resume');
  assert.equal(server.manager.get(room.roomCode).floor, undefined);
  const before = b.events.filter(event => event.type === 'signal').length;
  a.client.sendSignal('offer', 'must-not-relay', 1);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(b.events.filter(event => event.type === 'signal').length, before);
  a.client.sendSignal('offer', 'fresh-epoch-offer', 3);
  await until(() => b.events.some(event => event.type === 'signal' && event.payload === 'fresh-epoch-offer'), 'resumed offer');
  const errors = [...a.events, ...b.events].filter(event => event.type === 'error');
  assert.deepEqual(errors, []);
  console.log('PASS: real SignalingClient ↔ ws server create/join, floor, peer-drop, both-drop, resume tokens, independent generations, and epoch isolation.');
} finally {
  a.client.disconnect(); b.client.disconnect(); await server.close();
}
