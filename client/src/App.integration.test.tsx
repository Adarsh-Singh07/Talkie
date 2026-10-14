// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { deferred, FakePeer, FakeSocket, FakeStream, installMediaFakes, type WireMessage } from './test/fakes';

const native = vi.hoisted(() => new Map<string, Set<() => void>>());
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: () => void) => {
    if (!native.has(name)) native.set(name, new Set());
    native.get(name)!.add(callback);
    return () => native.get(name)?.delete(callback);
  }),
}));

let media: ReturnType<typeof installMediaFakes>;
const roots: Root[] = [];
const nativeEvent = (name: string) => native.get(name)?.forEach(callback => callback());
const space = (type: 'keydown' | 'keyup', repeat = false) => window.dispatchEvent(new KeyboardEvent(type, { code: 'Space', key: ' ', repeat, bubbles: true }));
const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const click = (element: Element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
function button(container: Element, label: string) { return [...container.querySelectorAll('button')].find(node => node.textContent === label)!; }

async function renderForm() {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<App />));
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('#display-name')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Tester');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return container;
}
async function mount() {
  const container = await renderForm();
  await act(async () => click(button(container, 'Create room')));
  const socket = FakeSocket.instances.at(-1)!;
  await act(async () => socket.open());
  return { container, socket };
}
async function joined(socket: FakeSocket, epoch = 1, fresh = false) {
  await act(async () => socket.message({ type: fresh ? 'joined' : 'created', roomCode: 'ABC123', ...(fresh ? {} : { invitationToken: 'secret', resumeToken: 'private-session-token' }) }));
  const peer = FakePeer.instances.at(-1)!;
  await act(async () => socket.message({ type: 'peer_ready', offerer: true, epoch }));
  await act(async () => peer.transition('connected'));
  return peer;
}
function grant(socket: FakeSocket, request = socket.messages('request_floor').at(-1)!, extra: Partial<WireMessage> = {}) {
  socket.message({ type: 'floor_granted', id: request.id, sessionId: socket.sessionId, epoch: request.epoch, leaseId: `lease-${String(request.id)}`, expiresAt: Date.now() + 30_000, leaseDurationMs: 30_000, ...extra });
}
async function start() { const state = await mount(); return { ...state, peer: await joined(state.socket) }; }
async function talk(socket: FakeSocket, peer: FakePeer) {
  await act(async () => space('keydown'));
  expect(peer.track.enabled).toBe(false);
  await act(async () => grant(socket));
  expect(peer.track.enabled).toBe(true);
}

beforeEach(() => {
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_SIGNALING_URL', 'ws://127.0.0.1:8787');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  window.localStorage.clear();
  media = installMediaFakes(); native.clear();
});
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('mounted App → signaling → AudioSession sender safety', () => {
  it('saves, uses, and resets the runtime signaling URL from lobby Server Settings', async () => {
    const container = await renderForm();
    await act(async () => click(container.querySelector('summary')!));
    const input = container.querySelector<HTMLInputElement>('#signaling-url')!;
    expect(input.value).toBe('ws://127.0.0.1:8787');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'wss://signal.talkie-validation-fixture.net/rooms');
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => click(button(container, 'Save')));
    expect(window.localStorage.getItem('talkie.signalingUrl')).toBe('wss://signal.talkie-validation-fixture.net/rooms');
    await act(async () => click(button(container, 'Reset')));
    expect(window.localStorage.getItem('talkie.signalingUrl')).toBeNull();
    expect(input.value).toBe('ws://127.0.0.1:8787');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'wss://signal.talkie-validation-fixture.net/rooms');
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => click(button(container, 'Save')));
    await act(async () => click(button(container, 'Create room')));
    expect(FakeSocket.instances.at(-1)?.url).toBe('wss://signal.talkie-validation-fixture.net/rooms');
    expect(container.querySelector('[role="alert"]')?.textContent ?? '').not.toContain('configuration error');
  });

  it('keeps a global shortcut transmission through blur and hidden until native release', async () => {
    const { container, socket, peer } = await start();
    await act(async () => nativeEvent('shortcut://pressed'));
    await act(async () => grant(socket));
    expect(peer.track.enabled).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(peer.track.enabled).toBe(true);
    await act(async () => nativeEvent('shortcut://released'));
    expect(peer.track.enabled).toBe(false);
    expect(container.textContent).toContain('PUSH TO TALK · OFF');
  });

  it.each([undefined, '', 'ws://127.0.0.1:8787', 'wss://localhost', 'wss://signal.example.com', 'malformed'])('blocks built-mode invalid config %s before connection or capture', async url => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_SIGNALING_URL', url);
    const container = await renderForm();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('VITE_SIGNALING_URL');
    expect(button(container, 'Create room').disabled).toBe(true);
    expect(button(container, 'Join room').disabled).toBe(true);
    await act(async () => {
      click(button(container, 'Create room'));
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(FakeSocket.instances).toHaveLength(0);
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
  it('shows actionable constructor failure without capturing a microphone', async () => {
    vi.stubGlobal('WebSocket', class { constructor() { throw new DOMException('Blocked', 'SecurityError'); } });
    const container = await renderForm();
    await act(async () => click(button(container, 'Create room')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Check VITE_SIGNALING_URL and browser security settings');
    expect(container.textContent).toContain('closed');
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
  it('shows an unreachable endpoint error before any microphone capture', async () => {
    const container = await renderForm();
    await act(async () => click(button(container, 'Create room')));
    await act(async () => FakeSocket.instances[0].onerror?.(new Event('error')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Check your network');
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
  it('mutes existing transmission on connection loss and handles a throwing reconnect constructor', async () => {
    const { container, socket, peer } = await start();
    await talk(socket, peer);
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('Connection blocked'); } });
    await act(async () => socket.close());
    expect(peer.track.enabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not start the signaling connection');
    expect(peer.track.enabled).toBe(false);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('playback recovery does not open the microphone or request the floor', async () => {
    const { container, socket, peer } = await start();
    await act(async () => click(button(container, 'Enable audio')));
    expect(peer.track.enabled).toBe(false); expect(socket.messages('request_floor')).toHaveLength(0);
  });
  it.each(['pointercancel', 'outside-release', 'hidden', 'native-close', 'native-blur', 'escape'])(
    'cancels a pending grant and active transmission on %s', async reason => {
      const { container, socket, peer } = await start();
      const reset = () => {
        if (reason === 'pointercancel') window.dispatchEvent(new Event('pointercancel'));
        else if (reason === 'outside-release') window.dispatchEvent(new Event('pointerup'));
        else if (reason === 'hidden') {
          vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
          document.dispatchEvent(new Event('visibilitychange'));
        } else if (reason === 'escape') escape();
        else nativeEvent(reason === 'native-close' ? 'window://close-requested' : 'window://blurred');
      };
      await act(async () => space('keydown'));
      await act(async () => reset());
      await act(async () => grant(socket));
      expect(peer.track.enabled).toBe(false);
      if (reason === 'escape') await act(async () => click(button(container, 'Clear emergency stop')));
      await act(async () => space('keyup')); await talk(socket, peer);
      await act(async () => reset()); expect(peer.track.enabled).toBe(false);
    },
  );

  it('rapid press/release cycles cannot accept the preceding request grant', async () => {
    const { socket, peer } = await start();
    for (let i = 0; i < 10; i++) {
      await act(async () => space('keydown'));
      const old = socket.messages('request_floor').at(-1)!;
      await act(async () => space('keyup'));
      await act(async () => space('keydown'));
      await act(async () => grant(socket, old)); expect(peer.track.enabled).toBe(false);
      await act(async () => grant(socket)); expect(peer.track.enabled).toBe(true);
      await act(async () => space('keyup')); expect(peer.track.enabled).toBe(false);
    }
    expect(new Set(socket.messages('request_floor').map(message => message.id)).size).toBe(20);
    expect(FakePeer.instances).toHaveLength(1);
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });
  it('uses the explicit development loopback URL and mutes synchronously on Space keyup before a throwing send', async () => {
    const { socket, peer } = await start();
    expect(socket.url).toBe('ws://127.0.0.1:8787');
    await talk(socket, peer);
    socket.onSend = message => { if (message.type === 'speaking' || message.type === 'release_floor') { expect(peer.track.enabled).toBe(false); throw new Error('socket lost'); } };
    await act(async () => space('keyup'));
    expect(peer.track.enabled).toBe(false);
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false });
  });

  it('rejects a late grant after keyup and does not let an old lease revoke a fresh lease', async () => {
    const { socket, peer } = await start();
    await act(async () => space('keydown'));
    const old = socket.messages('request_floor')[0];
    await act(async () => space('keyup'));
    await act(async () => grant(socket, old));
    expect(peer.track.enabled).toBe(false);
    await talk(socket, peer);
    for (const type of ['floor_released', 'floor_expired']) {
      await act(async () => socket.message({ type, sessionId: socket.sessionId, leaseId: `lease-${String(old.id)}`, epoch: 1 }));
      expect(peer.track.enabled).toBe(true);
    }
    const latest = socket.messages('request_floor').at(-1)!;
    await act(async () => socket.message({ type: 'floor_released', sessionId: socket.sessionId, leaseId: `lease-${String(latest.id)}`, epoch: 1 }));
    expect(peer.track.enabled).toBe(false);
  });

  it('coalesces Space/native repeated events and requires release after emergency reset', async () => {
    const { container, socket, peer } = await start();
    await act(async () => { space('keydown'); space('keydown', true); space('keydown'); nativeEvent('shortcut://pressed'); nativeEvent('shortcut://pressed'); });
    expect(socket.messages('request_floor')).toHaveLength(1);
    await act(async () => grant(socket)); expect(peer.track.enabled).toBe(true);
    await act(async () => { escape(); nativeEvent('shortcut://pressed'); });
    expect(peer.track.enabled).toBe(false);
    await act(async () => { click(button(container, 'Clear emergency stop')); nativeEvent('shortcut://pressed'); space('keydown', true); });
    expect(socket.messages('request_floor')).toHaveLength(1);
    expect(peer.track.enabled).toBe(false);
    await act(async () => { space('keyup'); nativeEvent('shortcut://released'); nativeEvent('shortcut://pressed'); nativeEvent('shortcut://pressed'); });
    expect(socket.messages('request_floor')).toHaveLength(2);
    await act(async () => grant(socket)); expect(peer.track.enabled).toBe(true);
    await act(async () => nativeEvent('shortcut://released')); expect(peer.track.enabled).toBe(false);
  });

  it('keeps focus-loss and an emergency in the same batch latched off until a fresh press', async () => {
    const { container, socket, peer } = await start(); await talk(socket, peer);
    await act(async () => { window.dispatchEvent(new Event('blur')); space('keydown'); grant(socket); });
    expect(peer.track.enabled).toBe(false);
    expect(socket.messages('request_floor')).toHaveLength(1);
    await act(async () => { space('keyup'); escape(); space('keydown'); });
    expect(socket.messages('request_floor')).toHaveLength(1);
    await act(async () => click(button(container, 'Clear emergency stop')));
    await act(async () => space('keydown'));
    expect(socket.messages('request_floor')).toHaveLength(1);
    await act(async () => space('keyup'));
    await talk(socket, peer);
  });

  it('does not turn a queued Emergency stop click into an emergency clear after Escape', async () => {
    const { container, socket, peer } = await start(); await talk(socket, peer);
    const stop = button(container, 'Emergency stop · Esc');
    await act(async () => { escape(); click(stop); space('keyup'); space('keydown'); });
    expect(peer.track.enabled).toBe(false);
    expect(container.textContent).toContain('Clear emergency stop');
    expect(socket.messages('request_floor')).toHaveLength(1);
  });

  it.each(['request_floor', 'speaking'])('fails closed when %s send throws', async type => {
    const { container, socket, peer } = await start();
    socket.onSend = message => { if (message.type === type) throw new Error('socket send failure'); };
    await act(async () => space('keydown'));
    if (type === 'speaking') await act(async () => grant(socket));
    expect(peer.track.enabled).toBe(false);
    expect(container.textContent).toContain('PUSH TO TALK · OFF');
  });

  it('fails closed through App when the actual sender track enable setter throws', async () => {
    const { container, socket, peer } = await start();
    let enabled = false;
    Object.defineProperty(peer.track, 'enabled', { get: () => enabled, set: (next: boolean) => { if (next) { enabled = true; throw new Error('failed setter'); } enabled = false; } });
    await act(async () => space('keydown'));
    await act(async () => grant(socket));
    expect(peer.track.enabled).toBe(false); expect(peer.track.readyState).toBe('ended');
    expect(container.textContent).toContain('PUSH TO TALK · OFF');
    expect(container.textContent).toContain('Microphone: not ready');
  });

  it('expires from the local request-send clock even when the grant and wall clock are delayed', async () => {
    const { container, socket, peer } = await start();
    await act(async () => space('keydown'));
    await act(async () => vi.advanceTimersByTime(800));
    vi.setSystemTime(new Date('2040-01-01'));
    await act(async () => grant(socket, undefined, { expiresAt: 1, leaseDurationMs: 1_000 }));
    expect(peer.track.enabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(199)); expect(peer.track.enabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1)); expect(peer.track.enabled).toBe(false);
    expect(container.textContent).toContain('PUSH TO TALK · OFF');
    await act(async () => { space('keyup'); space('keydown'); });
    await act(async () => vi.advanceTimersByTime(1_000));
    await act(async () => grant(socket, undefined, { leaseDurationMs: 1_000 }));
    expect(peer.track.enabled).toBe(false);
  });

  it.each(['devicechange', 'ended'] as const)('clears pending UI intent on %s and rejects the delayed grant', async event => {
    const { container, socket, peer } = await start();
    await act(async () => space('keydown'));
    await act(async () => event === 'devicechange' ? media.dispatchEvent(new Event('devicechange')) : peer.track.end());
    expect(container.textContent).toContain('PUSH TO TALK · OFF');
    await act(async () => grant(socket)); expect(peer.track.enabled).toBe(false);
  });

  it('never reopens the sender just because the peer reconnects', async () => {
    const { socket, peer } = await start(); await talk(socket, peer);
    await act(async () => peer.transition('disconnected')); expect(peer.track.enabled).toBe(false);
    await act(async () => peer.transition('connected')); expect(peer.track.enabled).toBe(false);
    await act(async () => grant(socket)); expect(peer.track.enabled).toBe(false);
    await act(async () => space('keyup')); await talk(socket, peer);
  });

  it('recovers the remaining peer through the fresh token-less joined ack and ready barrier', async () => {
    const { socket, peer } = await start(); await talk(socket, peer);
    await act(async () => socket.message({ type: 'peer_left' }));
    expect(peer.track.enabled).toBe(false); expect(peer.track.readyState).toBe('ended');
    const next = await joined(socket, 2, true);
    expect(socket.messages('ready')).toHaveLength(2);
    expect(next).not.toBe(peer); expect(next.track.enabled).toBe(false);
    await act(async () => socket.message({ type: 'floor_granted', sessionId: socket.sessionId, epoch: 1, leaseId: 'old', expiresAt: Date.now() + 1e6, leaseDurationMs: 30_000 }));
    expect(next.track.enabled).toBe(false);
    await act(async () => space('keyup')); await talk(socket, next);
    expect(socket.messages('request_floor').at(-1)).toMatchObject({ epoch: 2 });
  });

  it('recovers both mounted clients after their sockets reconnect with new generations', async () => {
    const a = await start(); const b = await start();
    await act(async () => { a.socket.close(); b.socket.close(); });
    expect(a.peer.track.enabled).toBe(false); expect(b.peer.track.enabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(1_000));
    const reconnects = FakeSocket.instances.slice(2); expect(reconnects).toHaveLength(2);
    const peers: FakePeer[] = [];
    for (const socket of reconnects) {
      await act(async () => socket.open());
      expect(socket.handshake).toMatchObject({ type: 'join', generation: 2, invitationToken: 'secret', resumeToken: 'private-session-token' });
      peers.push(await joined(socket, 2, true));
      expect(socket.messages('ready')).toHaveLength(1);
    }
    await act(async () => space('keydown'));
    await act(async () => grant(reconnects[0]));
    expect(peers[0].track.enabled).toBe(true); expect(peers[1].track.enabled).toBe(false);
    await act(async () => space('keyup'));
    expect(peers.every(peer => !peer.track.enabled)).toBe(true);
  });

  it('stops stale async getUserMedia and ignores queued old-context negotiation', async () => {
    const delayed = deferred<FakeStream>(); media.getUserMedia.mockImplementationOnce(() => delayed.promise);
    const { socket } = await mount();
    await act(async () => socket.message({ type: 'created', roomCode: 'ABC123', invitationToken: 'secret' }));
    const old = FakePeer.instances.at(-1)!;
    await act(async () => socket.message({ type: 'peer_ready', epoch: 1, offerer: true }));
    const next = await joined(socket, 2, true);
    const stale = new FakeStream();
    await act(async () => delayed.resolve(stale));
    expect(stale.track.enabled).toBe(false); expect(stale.track.readyState).toBe('ended');
    expect(old.createOffer).not.toHaveBeenCalled(); expect(next.createOffer).toHaveBeenCalledTimes(1);
    expect(next.track.enabled).toBe(false);
    expect(socket.messages('ready')).toHaveLength(1);
    await talk(socket, next);
  });

  it('does not let superseded device selection completion clear new UI intent', async () => {
    media.enumerateDevices.mockResolvedValue([{ deviceId: 'first', kind: 'audioinput', label: 'First' }, { deviceId: 'second', kind: 'audioinput', label: 'Second' }] as MediaDeviceInfo[]);
    const { container, socket, peer } = await start();
    const staleCapture = deferred<FakeStream>();
    media.getUserMedia.mockImplementationOnce(() => staleCapture.promise);
    const select = container.querySelector<HTMLSelectElement>('#input-device')!;
    await act(async () => { select.value = 'first'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { select.value = 'second'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await talk(socket, peer);
    const stale = new FakeStream();
    await act(async () => staleCapture.resolve(stale));
    expect(stale.track.readyState).toBe('ended'); expect(stale.track.enabled).toBe(false);
    expect(peer.track.enabled).toBe(true);
    expect(container.textContent).toContain('PUSH TO TALK · TRANSMITTING');
  });

  it('cannot publish an old in-flight offer or mutate the newer epoch peer', async () => {
    const { socket } = await mount();
    await act(async () => socket.message({ type: 'created', roomCode: 'ABC123', invitationToken: 'secret' }));
    const old = FakePeer.instances.at(-1)!;
    const offer = deferred<{ type: string; sdp: string }>(); old.createOffer.mockImplementationOnce(() => offer.promise);
    await act(async () => socket.message({ type: 'peer_ready', epoch: 1, offerer: true }));
    await act(async () => socket.message({ type: 'signal', epoch: 1, kind: 'answer', payload: 'stale-answer' }));
    await act(async () => socket.message({ type: 'peer_ready', epoch: 2, offerer: true }));
    const next = FakePeer.instances.at(-1)!;
    await act(async () => offer.resolve({ type: 'offer', sdp: 'stale-offer' }));
    expect(old.setLocalDescription).not.toHaveBeenCalled();
    expect(old.setRemoteDescription).not.toHaveBeenCalled();
    expect(next.setRemoteDescription).not.toHaveBeenCalled();
    expect(socket.messages('signal').every(message => message.epoch === 2)).toBe(true);
    expect(next.track.enabled).toBe(false);
  });
});
