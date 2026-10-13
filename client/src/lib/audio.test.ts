import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioSession, canTransmit, type TransmitGate } from './audio';
import { deferred, FakePeer, FakeStream, installMediaFakes } from '../test/fakes';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('AudioSession sender gate', () => {
  const gate = (): TransmitGate => ({ heldIntent: true, leaseValid: true, leaseDeadline: performance.now() + 1_000, emergency: false });

  it('bounds queued ICE until a remote description exists', async () => {
    installMediaFakes(); const session = new AudioSession(() => {});
    for (let i = 0; i < 256; i++) await session.addIce({ candidate: `candidate-${i}` });
    await expect(session.addIce({ candidate: 'overflow' })).rejects.toThrow('ice_queue_limit');
    session.close();
  });

  it('requires a finite future deadline and every safety condition', () => {
    expect(canTransmit(gate(), true, true, false)).toBe(true);
    for (const deadline of [undefined, NaN, Infinity, -Infinity, performance.now()]) expect(canTransmit({ ...gate(), leaseDeadline: deadline }, true, true, false)).toBe(false);
    for (const condition of [{ ...gate(), heldIntent: false }, { ...gate(), leaseValid: false }, { ...gate(), emergency: true }]) expect(canTransmit(condition, true, true, false)).toBe(false);
    expect(canTransmit(gate(), false, true, false)).toBe(false);
    expect(canTransmit(gate(), true, false, false)).toBe(false);
    expect(canTransmit(gate(), true, true, true)).toBe(false);
  });

  it('local mute leaves the remote stream and track active', async () => {
    installMediaFakes(); const session = new AudioSession(() => {});
    await session.prepare(); const peer = FakePeer.instances[0]; peer.transition('connected');
    const remote = new FakeStream();
    peer.ontrack?.({ streams: [remote], track: remote.track } as unknown as RTCTrackEvent);
    session.setTransmitGate(gate()); expect(peer.track.enabled).toBe(true);
    session.setTransmitting(false); expect(peer.track.enabled).toBe(false);
    expect(remote.track.enabled).toBe(true); expect(remote.track.readyState).toBe('live');
    session.close(); expect(remote.track.enabled).toBe(true);
  });

  it('owns expiry even with no App and invalidates the lease on any non-connected state', async () => {
    installMediaFakes(); const invalidated = vi.fn();
    const session = new AudioSession(() => {}, undefined, undefined, undefined, invalidated);
    await session.prepare(); const peer = FakePeer.instances[0]; peer.transition('connected');
    session.setTransmitting(true); expect(peer.track.enabled).toBe(false);
    session.setTransmitGate(gate()); expect(peer.track.enabled).toBe(true);
    peer.transition('connecting'); expect(peer.track.enabled).toBe(false);
    peer.transition('connected'); expect(peer.track.enabled).toBe(false);
    session.setTransmitting(true); expect(peer.track.enabled).toBe(false);
    session.setTransmitGate(gate());
    peer.iceConnectionState = 'disconnected'; peer.oniceconnectionstatechange?.(); expect(peer.track.enabled).toBe(false);
    peer.iceConnectionState = 'connected'; peer.oniceconnectionstatechange?.(); expect(peer.track.enabled).toBe(false);
    session.setTransmitGate(gate()); expect(peer.track.enabled).toBe(true);
    vi.advanceTimersByTime(1_000); expect(peer.track.enabled).toBe(false);
    expect(invalidated).toHaveBeenCalledWith('lease_expired');
    session.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it('stops a live track if its enabled setter fails and will not reenable it', async () => {
    installMediaFakes(); const invalidated = vi.fn();
    const session = new AudioSession(() => {}, undefined, undefined, undefined, invalidated);
    await session.prepare(); const peer = FakePeer.instances[0]; peer.transition('connected');
    let enabled = false;
    Object.defineProperty(peer.track, 'enabled', { get: () => enabled, set: (next: boolean) => { if (next) { enabled = true; throw new Error('setter failed after enable'); } enabled = false; } });
    session.setTransmitGate(gate());
    expect(peer.track.enabled).toBe(false); expect(peer.track.readyState).toBe('ended');
    expect(invalidated).toHaveBeenCalledWith('audio_track_failed');
    session.setTransmitGate(gate()); expect(peer.track.enabled).toBe(false);
    session.close();
  });

  it('fails closed if an ICE signaling send or replaceTrack throws', async () => {
    installMediaFakes(); const invalidated = vi.fn();
    const session = new AudioSession(() => { throw new Error('send failed'); }, undefined, undefined, undefined, invalidated);
    await session.prepare(); const peer = FakePeer.instances[0]; peer.transition('connected');
    session.setTransmitGate(gate()); expect(peer.track.enabled).toBe(true);
    peer.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'ice' }) } } as RTCPeerConnectionIceEvent);
    expect(peer.track.enabled).toBe(false);
    session.setTransmitGate(gate());
    peer.senders[0].replaceTrack = async () => { throw new Error('sender failed'); };
    await expect(session.setInput('different')).rejects.toThrow('sender failed');
    expect(peer.track.enabled).toBe(false);
    session.close();
  });

  it('stops superseded getUserMedia without attaching stale capture', async () => {
    const media = installMediaFakes(); const first = deferred<FakeStream>(); const second = deferred<FakeStream>();
    media.getUserMedia.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const session = new AudioSession(() => {}); const firstPrepare = session.prepare(); const secondPrepare = session.prepare();
    const stale = new FakeStream(); first.resolve(stale);
    await expect(firstPrepare).rejects.toThrow('audio_cancelled');
    expect(stale.track.readyState).toBe('ended'); expect(stale.track.enabled).toBe(false);
    const current = new FakeStream(); second.resolve(current); await secondPrepare;
    expect(FakePeer.instances[0].track).toBe(current.track); expect(current.track.enabled).toBe(false);
    session.close();
  });
});
