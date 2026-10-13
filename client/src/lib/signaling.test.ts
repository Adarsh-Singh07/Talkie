import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalingClient, type SignalingEvent } from './signaling';
import { FakeSocket } from '../test/fakes';

function setup() {
  const sockets: FakeSocket[] = []; const events: SignalingEvent[] = [];
  const client = new SignalingClient('ws://test', url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; });
  client.on(event => events.push(event)); client.create(); sockets[0].open();
  const socket = sockets[0];
  const joined = () => socket.message({ type: 'created', roomCode: 'ABC123', invitationToken: 'secret', resumeToken: 'private-session-token' });
  const ready = (epoch = 1) => socket.message({ type: 'peer_ready', offerer: true, epoch });
  return { client, socket, sockets, events, joined, ready };
}

describe('versioned signaling', () => {
  it('recovers after repeated failed retries without losing private resume proof', () => {
    vi.useFakeTimers();
    const { client, socket, sockets, joined } = setup(); joined();
    socket.close();
    for (let attempt = 1; attempt <= 3; attempt++) {
      vi.advanceTimersByTime(40_000);
      expect(sockets).toHaveLength(attempt + 1);
      sockets[attempt].onerror?.(new Event('error'));
    }
    vi.advanceTimersByTime(40_000);
    sockets[4].open();
    expect(sockets[4].handshake).toMatchObject({ type: 'join', generation: 5, resumeToken: 'private-session-token' });
    sockets[4].message({ type: 'joined', roomCode: 'ABC123' });
    expect(client.state).toBe('joined'); expect(client.currentEpoch).toBeUndefined();
    client.disconnect(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects missing/wrong version or generation including room acks and errors', () => {
    const { client, socket, events } = setup();
    for (const type of ['created', 'joined', 'error', 'peer_left']) {
      for (const invalid of [{ v: undefined }, { v: 2 }, { generation: undefined }, { generation: 0 }, { generation: 2 }]) {
        socket.message({ type, roomCode: 'ABC123', invitationToken: 'secret', code: 'fatal', ...invalid });
      }
    }
    expect(events.every(event => event.type === 'state')).toBe(true);
    socket.message({ type: 'created', roomCode: 'ABC123', invitationToken: 'secret' });
    expect(events).toContainEqual({ type: 'room', roomCode: 'ABC123', invitationToken: 'secret' });
    client.disconnect();
  });

  it('accepts positive strictly increasing integer epochs, including across fresh joined acks', () => {
    const { client, socket, events, joined, ready } = setup(); joined();
    for (const epoch of [0, -1, 0.5, '1', null]) socket.message({ type: 'peer_ready', offerer: true, epoch });
    ready(2); ready(2); ready(1);
    socket.message({ type: 'joined', roomCode: 'ABC123' }); ready(1); ready(2); ready(3);
    expect(events.filter(event => event.type === 'peer_ready').map(event => event.epoch)).toEqual([2, 3]);
    client.disconnect();
  });

  it('scopes every floor command and event to the active epoch and validates finite leases', () => {
    const { client, socket, events, joined, ready } = setup(); joined(); ready();
    const id = client.requestFloor(); client.speaking('lease', true); client.releaseFloor('lease');
    for (const type of ['request_floor', 'speaking', 'release_floor']) expect(socket.messages(type)[0]).toMatchObject({ v: 1, generation: 1, epoch: 1 });
    const floor = { sessionId: client.currentSessionId, leaseId: 'lease', epoch: 1, id, expiresAt: 10, leaseDurationMs: 30_000, speaking: true };
    for (const type of ['floor_granted', 'floor_released', 'floor_expired', 'speaking']) {
      for (const epoch of [undefined, 0, 2]) socket.message({ type, ...floor, epoch });
    }
    expect(events.filter(event => event.type.startsWith('floor_') || event.type === 'speaking')).toHaveLength(0);
    socket.message({ type: 'floor_granted', ...floor, leaseDurationMs: undefined });
    socket.message({ type: 'floor_granted', ...floor, leaseDurationMs: -1 });
    socket.message({ type: 'floor_granted', ...floor });
    socket.message({ type: 'floor_released', ...floor });
    socket.message({ type: 'floor_expired', ...floor });
    socket.message({ type: 'speaking', ...floor });
    expect(events.filter(event => event.type.startsWith('floor_') || event.type === 'speaking')).toHaveLength(4);
    client.disconnect();
  });

  it('resets ready on token-less fresh ack and on socket reconnect; rejects old callbacks', () => {
    vi.useFakeTimers();
    const { client, socket, sockets, events, joined } = setup();
    expect(client.ready()).toBe(false); joined(); expect(client.ready()).toBe(true); expect(client.ready()).toBe(false);
    socket.message({ type: 'joined', roomCode: 'ABC123' }); expect(client.ready()).toBe(true);
    socket.close(); vi.advanceTimersByTime(1_000); sockets[1].open();
    expect(sockets[1].handshake).toMatchObject({ type: 'join', generation: 2, invitationToken: 'secret', resumeToken: 'private-session-token' });
    expect(events.filter(event => event.type === 'room').every(event => !('resumeToken' in event))).toBe(true);
    sockets[1].message({ type: 'joined', roomCode: 'ABC123' }); expect(client.ready()).toBe(true);
    const count = events.length; socket.message({ type: 'error', code: 'old' }); expect(events).toHaveLength(count);
    client.disconnect();
  });
});
afterEach(() => vi.useRealTimers());
