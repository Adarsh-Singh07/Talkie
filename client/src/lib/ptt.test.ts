import { describe, expect, it } from 'vitest';
import { canAcceptFloorGrant, initialPttState, pttReducer, type PttEvent } from './ptt';

const ready = () => pttReducer(initialPttState, { type: 'gates', connected: true, inRoom: true, micReady: true });
const requesting = () => pttReducer(ready(), { type: 'press' });
const transmitting = () => pttReducer(requesting(), { type: 'grant', requestId: 1 });

describe('fail-closed PTT intent', () => {
  it('defaults off and cannot request without readiness', () => {
    expect(initialPttState.phase).toBe('off');
    expect(pttReducer(initialPttState, { type: 'press' }).phase).toBe('off');
    expect(pttReducer(initialPttState, { type: 'grant', requestId: 0 }).phase).toBe('off');
  });

  for (const gate of ['connected', 'inRoom', 'micReady'] as const) {
    it(`blocks transmission without ${gate}, including loss during transmission`, () => {
      const gates = { type: 'gates' as const, connected: true, inRoom: true, micReady: true, [gate]: false };
      const blocked = pttReducer(ready(), gates);
      expect(pttReducer(blocked, { type: 'press' }).phase).toBe('off');
      expect(pttReducer(transmitting(), gates).phase).toBe('off');
      expect(pttReducer(pttReducer(requesting(), gates), { type: 'grant', requestId: 1 }).phase).toBe('off');
    });
  }

  it('requires a matching grant, and ignores repeated presses', () => {
    expect(requesting().phase).toBe('requesting');
    expect(pttReducer(requesting(), { type: 'press' })).toEqual(requesting());
    expect(pttReducer(requesting(), { type: 'grant', requestId: 5 }).phase).toBe('requesting');
    expect(transmitting().phase).toBe('transmitting');
  });

  for (const type of ['release', 'deny', 'emergency', 'focus-loss', 'hidden', 'disconnect', 'leave'] as const) {
    it(`resets on ${type} and rejects late grants`, () => {
      for (const state of [requesting(), transmitting()]) {
        const reset = pttReducer(state, { type } as PttEvent);
        expect(reset.phase).toBe('off');
        expect(pttReducer(reset, { type: 'grant', requestId: 1 }).phase).toBe('off');
      }
    });
  }

  it('rejects an old grant after a new press', () => {
    const second = pttReducer(pttReducer(requesting(), { type: 'release' }), { type: 'press' });
    expect(second.requestId).toBe(2);
    expect(pttReducer(second, { type: 'grant', requestId: 1 }).phase).toBe('requesting');
  });

  it('requires explicit readiness after disconnect and a fresh press after focus loss', () => {
    expect(pttReducer(pttReducer(transmitting(), { type: 'disconnect' }), { type: 'press' }).phase).toBe('off');
    const reset = pttReducer(transmitting(), { type: 'focus-loss' });
    expect(pttReducer(reset, { type: 'gates', connected: true, inRoom: true, micReady: true }).phase).toBe('off');
  });

  it('accepts only the still-pending, identified, unexpired floor grant', () => {
    const state = requesting();
    const pending = { id: 'request-2', sessionId: 'session', generation: 4, epoch: 1, requestedAt: 1_000 };
    const grant = { id: 'request-2', sessionId: 'session', generation: 4, epoch: 1, leaseDurationMs: 1_000, expiresAt: 2_000 };
    expect(canAcceptFloorGrant(grant, pending, state, true, 1_000)).toBe(true);
    expect(canAcceptFloorGrant({ ...grant, id: 'old-request' }, pending, state, true, 1_000)).toBe(false);
    expect(canAcceptFloorGrant({ ...grant, id: undefined }, pending, state, true, 1_000)).toBe(false);
    expect(canAcceptFloorGrant({ ...grant, generation: 5 }, pending, state, true, 1_000)).toBe(false);
    expect(canAcceptFloorGrant({ ...grant, sessionId: 'other-session' }, pending, state, true, 1_000)).toBe(false);
    expect(canAcceptFloorGrant(grant, undefined, state, true, 1_000)).toBe(false);
    expect(canAcceptFloorGrant(grant, pending, state, false, 1_000)).toBe(false);
    expect(canAcceptFloorGrant({ ...grant, epoch: 2 }, pending, state, true, 1_000)).toBe(false);
    expect(canAcceptFloorGrant(grant, pending, state, true, 2_000)).toBe(false);
    expect(canAcceptFloorGrant({ ...grant, expiresAt: 1 }, pending, state, true, 1_000)).toBe(true);
  });

  it('rejects a late old grant after release and a new request', () => {
    const second = pttReducer(pttReducer(requesting(), { type: 'release' }), { type: 'press' });
    const oldGrant = { id: 'first', sessionId: 'session', generation: 1, epoch: 1, leaseDurationMs: 4_000, expiresAt: 5_000 };
    const secondRequest = { id: 'second', sessionId: 'session', generation: 1, epoch: 1, requestedAt: 1_000 };
    expect(canAcceptFloorGrant(oldGrant, secondRequest, second, true, 1_000)).toBe(false);
    expect(canAcceptFloorGrant({ ...oldGrant, id: 'second' }, secondRequest, second, true, 1_000)).toBe(true);
  });
});
