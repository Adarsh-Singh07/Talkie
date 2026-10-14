/** Local intent only: this reducer never opens a microphone or sends audio. */
export type PttState = {
  connected: boolean;
  inRoom: boolean;
  micReady: boolean;
  phase: 'off' | 'requesting' | 'transmitting';
  requestId: number;
  emergency: boolean;
  triggerSource: PttTriggerSource;
};

export type PttTriggerSource = 'ui' | 'global-shortcut' | null;

export const initialPttState: PttState = {
  connected: false, inRoom: false, micReady: false, phase: 'off', requestId: 0, emergency: false, triggerSource: null,
};

export type PttEvent =
  | { type: 'gates'; connected: boolean; inRoom: boolean; micReady: boolean }
  | { type: 'press'; source?: Exclude<PttTriggerSource, null> }
  | { type: 'grant'; requestId: number }
  | { type: 'release'; source?: Exclude<PttTriggerSource, null> }
  | { type: 'deny' | 'emergency' | 'clear-emergency' | 'focus-loss' | 'hidden' | 'disconnect' | 'leave' };

export type FloorGrantIdentity = { id?: string; sessionId: string; generation: number; epoch: number; leaseDurationMs: number; expiresAt: number };
export type PendingFloorRequest = { id: string; sessionId: string; generation: number; epoch: number; requestedAt: number };

/** A grant must be tied to the still-held request; id-less grants fail closed. */
export function canAcceptFloorGrant(grant: FloorGrantIdentity, pending: PendingFloorRequest | undefined, state: PttState, held: boolean, now: number): boolean {
  return Boolean(
    pending
      && grant.id !== undefined
      && grant.id === pending.id
      && grant.sessionId === pending.sessionId
      && grant.generation === pending.generation
      && grant.epoch === pending.epoch
      && Number.isFinite(grant.leaseDurationMs) && grant.leaseDurationMs > 0
      && Number.isFinite(pending.requestedAt + grant.leaseDurationMs)
      && pending.requestedAt + grant.leaseDurationMs > now
      && state.phase === 'requesting'
      && held
      && !state.emergency,
  );
}

export function canRequestPtt(state: PttState): boolean {
  return !state.emergency && state.connected && state.inRoom && state.micReady;
}

export function pttReducer(state: PttState, event: PttEvent): PttState {
  switch (event.type) {
    case 'emergency': return { ...state, phase: 'off', emergency: true, triggerSource: null };
    case 'clear-emergency': return { ...state, phase: 'off', emergency: false, triggerSource: null };
    case 'gates': {
      const next = { ...state, connected: event.connected, inRoom: event.inRoom, micReady: event.micReady };
      return canRequestPtt(next) ? next : { ...next, phase: 'off', triggerSource: null };
    }
    case 'press':
      return canRequestPtt(state) && state.phase === 'off'
        ? { ...state, phase: 'requesting', requestId: state.requestId + 1, triggerSource: event.source ?? 'ui' } : state;
    case 'grant':
      return canRequestPtt(state) && state.phase === 'requesting' && event.requestId === state.requestId
        ? { ...state, phase: 'transmitting' } : state;
    case 'release':
      return event.source && event.source !== state.triggerSource ? state : { ...state, phase: 'off', triggerSource: null };
    case 'disconnect':
      return { ...state, connected: false, inRoom: false, micReady: false, phase: 'off', triggerSource: null };
    case 'leave':
      return { ...state, inRoom: false, micReady: false, phase: 'off', triggerSource: null };
    case 'focus-loss':
    case 'hidden':
      return state.triggerSource === 'ui' ? { ...state, phase: 'off', triggerSource: null } : state;
    default:
      return { ...state, phase: 'off', triggerSource: null };
  }
}
