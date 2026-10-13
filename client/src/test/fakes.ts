import { vi } from 'vitest';

export class FakeTrack {
  readonly kind = 'audio';
  enabled = true;
  readyState: MediaStreamTrackState = 'live';
  onended: (() => void) | null = null;
  stop() { this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.onended?.(); }
}

export class FakeStream {
  constructor(readonly track = new FakeTrack()) {}
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}

export class FakePeer {
  static instances: FakePeer[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  senders: { track: FakeTrack; replaceTrack: (next: FakeTrack) => Promise<void> }[] = [];
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'fake-offer' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'fake-answer' }));
  setLocalDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {});
  setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => { this.remoteDescription = description; });
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  constructor() { FakePeer.instances.push(this); }
  getSenders() { return this.senders; }
  addTrack(track: FakeTrack) {
    const sender = { track, replaceTrack: async (next: FakeTrack) => { sender.track = next; } };
    this.senders.push(sender);
    return sender;
  }
  transition(state: RTCPeerConnectionState) { this.connectionState = state; this.onconnectionstatechange?.(); }
  close() { this.connectionState = 'closed'; }
  get track() { return this.senders[0]?.track; }
}

export class FakeAudio {
  autoplay = false;
  srcObject: MediaStream | null = null;
  setAttribute() {}
  async play() {}
}

export type WireMessage = Record<string, unknown> & { type: string };
export class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: WireMessage[] = [];
  onSend?: (message: WireMessage) => void;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(raw: string) { const message = JSON.parse(raw) as WireMessage; this.onSend?.(message); this.sent.push(message); }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  close() { this.readyState = 3; this.onclose?.({} as CloseEvent); }
  message(message: WireMessage) { this.onmessage?.({ data: JSON.stringify({ v: 1, generation: this.generation, ...message }) } as MessageEvent); }
  messages(type: string) { return this.sent.filter(message => message.type === type); }
  get handshake() { return this.sent.find(message => message.type === 'create' || message.type === 'join')!; }
  get generation() { return this.handshake?.generation as number; }
  get sessionId() { return this.handshake.sessionId as string; }
}

export function installMediaFakes() {
  FakePeer.instances = []; FakeSocket.instances = [];
  const mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: vi.fn(async (_constraints?: MediaStreamConstraints) => new FakeStream()),
    enumerateDevices: vi.fn(async () => [] as MediaDeviceInfo[]),
  });
  vi.stubGlobal('navigator', { mediaDevices });
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('WebSocket', FakeSocket);
  return mediaDevices;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
