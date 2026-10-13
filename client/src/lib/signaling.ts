export type SignalKind = 'offer' | 'answer' | 'ice';
export type SignalingState = 'idle' | 'connecting' | 'connected' | 'joined' | 'closed';
type SocketLike = Pick<WebSocket, 'send' | 'close'> & { readyState: number; onopen: ((event: Event) => void) | null; onclose: ((event: CloseEvent) => void) | null; onerror: ((event: Event) => void) | null; onmessage: ((event: MessageEvent) => void) | null };
type SocketFactory = (url: string) => SocketLike;
export type SignalingEvent =
  | { type: 'state'; state: SignalingState }
  | { type: 'room'; roomCode: string; invitationToken: string; iceServers?: RTCIceServer[] }
  | { type: 'peer_ready'; offerer: boolean; epoch: number; generation: number }
  | { type: 'peer_left'; generation: number }
  | { type: 'signal'; kind: SignalKind; payload: string; generation: number; epoch: number }
  | { type: 'floor_granted'; id?: string; sessionId: string; generation: number; epoch: number; leaseId: string; expiresAt: number; leaseDurationMs: number }
  | { type: 'floor_busy'; id?: string }
  | { type: 'floor_released'; sessionId: string; generation: number; epoch: number; leaseId: string }
  | { type: 'floor_expired'; sessionId: string; generation: number; epoch: number; leaseId: string }
  | { type: 'speaking'; sessionId: string; generation: number; epoch: number; leaseId: string; speaking: boolean }
  | { type: 'error'; code: string };

const OPEN = 1;
const defaultFactory: SocketFactory = url => new WebSocket(url);

/** Authenticated room signaling only. Media never passes through this class. */
export class SignalingClient {
  private socket?: SocketLike;
  private generation = 0;
  private stopped = false;
  private credentials?: { mode: 'create' | 'join'; roomCode?: string; invitationToken?: string; resumeToken?: string };
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retries = 0;
  private epoch?: number;
  private highestEpoch = 0;
  private readyGeneration?: number;
  private readonly listeners = new Set<(event: SignalingEvent) => void>();
  public state: SignalingState = 'idle';

  constructor(private readonly url: string, private readonly socketFactory: SocketFactory = defaultFactory) {}
  on(listener: (event: SignalingEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: SignalingEvent) { this.listeners.forEach(listener => listener(event)); }
  private setState(state: SignalingState) { this.state = state; this.emit({ type: 'state', state }); }

  create() { this.highestEpoch = 0; this.credentials = { mode: 'create' }; this.connect(); }
  join(roomCode: string, invitationToken: string) { this.highestEpoch = 0; this.credentials = { mode: 'join', roomCode, invitationToken }; this.connect(); }
  private connect() {
    this.stopped = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const generation = ++this.generation;
    this.socket?.close();
    this.epoch = undefined;
    this.readyGeneration = undefined;
    this.setState('connecting');
    this.socket = undefined;
    let socket: SocketLike;
    try { socket = this.socket = this.socketFactory(this.url); }
    catch {
      // Invalid URLs and browser security restrictions can throw synchronously.
      // No socket exists to deliver an error/close callback in this case.
      this.stopped = true;
      this.setState('closed');
      this.emit({ type: 'error', code: 'signaling_start_failed' });
      return;
    }
    socket.onopen = () => {
      if (generation !== this.generation || this.stopped) return;
      this.setState('connected');
      const id = crypto.randomUUID(); const c = this.credentials!;
      try {
        this.sendRaw(c.mode === 'create' ? { v: 1, id, type: 'create', sessionId: this.sessionId, generation } : { v: 1, id, type: 'join', roomCode: c.roomCode!, invitationToken: c.invitationToken!, sessionId: this.sessionId, generation, ...(c.resumeToken ? { resumeToken: c.resumeToken } : {}) });
      } catch { this.emit({ type: 'error', code: 'signaling_unavailable' }); socket.close(); }
    };
    socket.onmessage = event => this.receive(event.data, generation);
    socket.onerror = () => {
      if (generation !== this.generation || this.stopped) return;
      this.emit({ type: 'error', code: 'signaling_unavailable' });
      // Browsers do not guarantee a close after an error. Force the normal
      // generation-guarded close path so reconnect negotiation cannot stall.
      if (socket.readyState !== 3) socket.close();
    };
    socket.onclose = () => {
      if (generation !== this.generation || this.stopped) return;
      this.emit({ type: 'error', code: 'signaling_unavailable' });
      this.setState('idle');
      this.epoch = undefined;
      this.readyGeneration = undefined;
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          if (!this.stopped && generation === this.generation) this.connect();
        }, Math.min(30_000, 500 * 2 ** Math.min(this.retries++, 6)) * (0.75 + Math.random() * 0.5));
      }
    };
  }
  private readonly sessionId = crypto.randomUUID();
  private sendRaw(value: object) { if (this.socket?.readyState !== OPEN) throw new Error('signaling_unavailable'); this.socket.send(JSON.stringify(value)); }
  ready() {
    if (this.state !== 'joined' || this.socket?.readyState !== OPEN || this.readyGeneration === this.generation) return false;
    this.sendRaw({ v: 1, id: crypto.randomUUID(), type: 'ready', generation: this.generation });
    this.readyGeneration = this.generation;
    return true;
  }
  private validEpoch(epoch: number | undefined): epoch is number {
    return typeof epoch === 'number' && Number.isSafeInteger(epoch) && epoch > 0 && epoch === this.epoch;
  }
  sendSignal(kind: SignalKind, payload: string, epoch = this.epoch) { if (this.validEpoch(epoch)) this.sendRaw({ v: 1, id: crypto.randomUUID(), type: 'signal', kind, payload, generation: this.generation, epoch }); }
  requestFloor(epoch = this.epoch) {
    if (!this.validEpoch(epoch)) return undefined;
    const id = crypto.randomUUID();
    this.sendRaw({ v: 1, id, type: 'request_floor', generation: this.generation, epoch });
    return id;
  }
  releaseFloor(leaseId: string, epoch = this.epoch) { if (this.validEpoch(epoch)) this.sendRaw({ v: 1, id: crypto.randomUUID(), type: 'release_floor', generation: this.generation, epoch, leaseId }); }
  speaking(leaseId: string, speaking: boolean, epoch = this.epoch) { if (this.validEpoch(epoch)) this.sendRaw({ v: 1, id: crypto.randomUUID(), type: 'speaking', generation: this.generation, epoch, leaseId, speaking }); }
  private receive(raw: unknown, generation: number) {
    if (generation !== this.generation || this.stopped || this.socket?.readyState !== OPEN) return;
    try {
      const message = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as Record<string, unknown>;
      if (!message || typeof message !== 'object' || message.v !== 1 || message.generation !== generation) return;
      const responseGeneration = message.generation;
      if ((message.type === 'created' || message.type === 'joined') && typeof message.roomCode === 'string' && responseGeneration === generation) {
        const invitationToken = typeof message.invitationToken === 'string' ? message.invitationToken : this.credentials?.invitationToken;
        if (!invitationToken) return;
        // The private session credential is never exposed in the shareable room
        // event. Peer-refresh acks omit it and must retain the existing value.
        const resumeToken = typeof message.resumeToken === 'string' && message.resumeToken ? message.resumeToken : this.credentials?.resumeToken;
        this.credentials = { mode: 'join', roomCode: message.roomCode, invitationToken, resumeToken }; this.retries = 0; this.epoch = undefined; this.readyGeneration = undefined;
        this.setState('joined'); const roomEvent: Extract<SignalingEvent, { type: 'room' }> = { type: 'room', roomCode: message.roomCode, invitationToken }; if (Array.isArray(message.iceServers)) roomEvent.iceServers = message.iceServers as RTCIceServer[]; this.emit(roomEvent); return;
      }
      if (message.type === 'peer_left' && message.generation === generation) { this.epoch = undefined; this.emit({ type: 'peer_left', generation }); return; }
      if (message.type === 'peer_ready' && typeof message.offerer === 'boolean') {
        if (typeof message.epoch !== 'number' || !Number.isSafeInteger(message.epoch) || message.epoch <= this.highestEpoch) return;
        this.highestEpoch = this.epoch = message.epoch; this.emit({ type: 'peer_ready', offerer: message.offerer, epoch: message.epoch, generation }); return;
      }
      if (message.type === 'signal' && (message.kind === 'offer' || message.kind === 'answer' || message.kind === 'ice') && typeof message.payload === 'string' && message.generation === generation && this.validEpoch(message.epoch as number)) { this.emit({ type: 'signal', kind: message.kind, payload: message.payload, generation, epoch: message.epoch as number }); return; }
      if (message.type === 'floor_granted' && typeof message.sessionId === 'string' && message.generation === generation && this.validEpoch(message.epoch as number) && typeof message.leaseId === 'string' && typeof message.expiresAt === 'number' && Number.isFinite(message.expiresAt) && typeof message.leaseDurationMs === 'number' && Number.isFinite(message.leaseDurationMs) && message.leaseDurationMs > 0) { const event: Extract<SignalingEvent, { type: 'floor_granted' }> = { type: 'floor_granted', sessionId: message.sessionId, generation, epoch: message.epoch as number, leaseId: message.leaseId, expiresAt: message.expiresAt, leaseDurationMs: message.leaseDurationMs }; if (typeof message.id === 'string') event.id = message.id; this.emit(event); return; }
      if (message.type === 'floor_released' && typeof message.sessionId === 'string' && message.generation === generation && this.validEpoch(message.epoch as number) && typeof message.leaseId === 'string') { this.emit({ type: 'floor_released', sessionId: message.sessionId, generation, epoch: message.epoch as number, leaseId: message.leaseId }); return; }
      if (message.type === 'floor_expired' && typeof message.sessionId === 'string' && message.generation === generation && this.validEpoch(message.epoch as number) && typeof message.leaseId === 'string') { this.emit({ type: 'floor_expired', sessionId: message.sessionId, generation, epoch: message.epoch as number, leaseId: message.leaseId }); return; }
      if (message.type === 'speaking' && typeof message.sessionId === 'string' && message.generation === generation && this.validEpoch(message.epoch as number) && typeof message.leaseId === 'string' && typeof message.speaking === 'boolean') { this.emit({ type: 'speaking', sessionId: message.sessionId, generation, epoch: message.epoch as number, leaseId: message.leaseId, speaking: message.speaking }); return; }
      if (message.type === 'error' && typeof message.code === 'string') { if (message.epoch !== undefined && message.epoch !== this.epoch) return; if (message.code === 'floor_busy') this.emit({ type: 'floor_busy', id: typeof message.id === 'string' ? message.id : undefined }); else this.emit({ type: 'error', code: message.code }); return; }
    } catch { this.emit({ type: 'error', code: 'invalid_server_message' }); }
  }
  disconnect() {
    try { this.sendRaw({ v: 1, id: crypto.randomUUID(), type: 'leave', generation: this.generation }); } catch { /* local teardown must finish even if the socket failed */ }
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.generation++;
    this.epoch = undefined;
    this.readyGeneration = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.setState('closed');
  }
  get currentGeneration() { return this.generation; }
  get currentSessionId() { return this.sessionId; }
  get currentEpoch() { return this.epoch; }
}
