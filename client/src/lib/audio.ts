export type AudioDevices = { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] };
export type TransmitGate = { heldIntent: boolean; leaseValid: boolean; leaseDeadline?: number; emergency: boolean };
const monotonicNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * The sender is enabled only when every safety condition is true.  Keeping
 * this as a pure predicate makes it difficult for a UI race to accidentally
 * bypass the media gate.
 */
export function canTransmit(gate: TransmitGate, peerConnected: boolean, micLive: boolean, closed: boolean, now = monotonicNow()): boolean {
  const deadline = gate.leaseDeadline;
  return gate.heldIntent && gate.leaseValid && Number.isFinite(deadline) && deadline! > now && peerConnected && micLive && !gate.emergency && !closed;
}

export class AudioSession {
  private stream?: MediaStream;
  private inputId?: string;
  private outputId?: string;
  private readonly peer: RTCPeerConnection;
  private readonly audio: HTMLAudioElement;
  private closed = false;
  private revision = 0;
  private trackFailed = false;
  private transmitGate: TransmitGate = { heldIntent: false, leaseValid: false, emergency: false };
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private notifyingInvalidation = false;
  constructor(private readonly onIce: (candidate: RTCIceCandidateInit) => void, private readonly onRemote?: (connected: boolean) => void, config?: RTCConfiguration, private readonly onFailure?: (message: string) => void, private readonly onGateInvalidated?: (reason: string) => void) {
    this.peer = new RTCPeerConnection(config);
    this.audio = new Audio(); this.audio.autoplay = true; this.audio.setAttribute('aria-label', 'Remote Talkie audio');
    this.peer.onicecandidate = event => { if (!this.closed && event.candidate) { try { this.onIce(event.candidate.toJSON()); } catch { this.invalidateGate('signaling_failed', true); } } };
    this.peer.ontrack = event => {
      if (this.closed) return;
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.resumePlayback().catch(() => { if (!this.closed) this.onFailure?.('Remote playback blocked. Click Enable audio.'); });
    };
    this.peer.onconnectionstatechange = () => {
      if (this.peer.connectionState !== 'connected') this.invalidateGate('peer_disconnected', true);
      else this.applyTransmitGate();
      onRemote?.(this.connected);
    };
    this.peer.oniceconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(this.peer.iceConnectionState)) {
        this.invalidateGate('peer_disconnected', true);
        onRemote?.(false);
      }
    };
    navigator.mediaDevices.addEventListener('devicechange', this.deviceChanged);
  }
  private deviceChanged = () => { this.invalidateGate('device_changed', true); this.onFailure?.('Audio devices changed. Select your microphone again.'); };
  async prepare(inputDeviceId?: string) {
    if (this.closed) throw new Error('audio_closed');
    const revision = ++this.revision;
    this.setTransmitting(false);
    this.inputId = inputDeviceId;
    const constraints: MediaStreamConstraints = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false, ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}) }, video: false };
    const next = await navigator.mediaDevices.getUserMedia(constraints);
    if (this.closed || revision !== this.revision) { next.getTracks().forEach(track => { try { track.enabled = false; } catch { /* stale capture is stopped below */ } track.stop(); }); throw new Error('audio_cancelled'); }
    try { next.getTracks().forEach(track => { track.enabled = false; }); } catch (error) { next.getTracks().forEach(track => track.stop()); this.invalidateGate('audio_track_failed', true); throw error; }
    const track = next.getAudioTracks()[0]; if (!track) { next.getTracks().forEach(t => t.stop()); throw new Error('microphone_unavailable'); }
    const old = this.stream;
    try {
      const sender = this.peer.getSenders().find(sender => sender.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(track); else this.peer.addTrack(track, next);
      if (this.closed || revision !== this.revision) throw new Error('audio_cancelled');
      this.stream = next;
      this.trackFailed = false;
      track.onended = () => { this.invalidateGate('microphone_ended', true); this.onFailure?.('Microphone disconnected. Select a microphone again.'); };
      old?.getTracks().forEach(t => { t.onended = null; t.stop(); });
      this.applyTransmitGate();
    } catch (error) { if (!this.closed && revision === this.revision) this.invalidateGate('audio_send_failed', true); next.getTracks().forEach(t => t.stop()); throw error; }
    return true;
  }
  async devices(): Promise<AudioDevices> { const devices = await navigator.mediaDevices.enumerateDevices(); return { inputs: devices.filter(d => d.kind === 'audioinput'), outputs: devices.filter(d => d.kind === 'audiooutput') }; }
  async setInput(id: string) { await this.prepare(id); }
  async setOutput(id: string) { this.outputId = id; const sink = (this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId; if (sink) await sink.call(this.audio, id); }
  setTransmitGate(gate: TransmitGate) {
    this.transmitGate = gate;
    this.scheduleExpiry();
    this.applyTransmitGate();
  }
  /** Compatibility helper that can only add held intent; it never creates a lease. */
  setTransmitting(enabled: boolean) {
    this.setTransmitGate(enabled ? { ...this.transmitGate, heldIntent: true } : { ...this.transmitGate, heldIntent: false, leaseValid: false, leaseDeadline: undefined });
  }
  private monotonicNow() { return monotonicNow(); }
  private scheduleExpiry() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const deadline = this.transmitGate.leaseDeadline;
    if (!this.transmitGate.leaseValid || !Number.isFinite(deadline)) return;
    const remaining = deadline! - this.monotonicNow();
    if (remaining <= 0) { this.invalidateGate('lease_expired', true); return; }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      if (this.transmitGate.leaseDeadline === deadline) this.scheduleExpiry();
    }, Math.min(2_147_483_647, Math.max(1, Math.ceil(remaining))));
  }
  private invalidateGate(reason: string, notify: boolean) {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.transmitGate = { heldIntent: false, leaseValid: false, emergency: false };
    this.applyTransmitGate();
    if (notify && !this.notifyingInvalidation) {
      this.notifyingInvalidation = true;
      try { this.onGateInvalidated?.(reason); } finally { this.notifyingInvalidation = false; }
    }
  }
  private applyTransmitGate() {
    const enabled = canTransmit(this.transmitGate, this.connected, this.microphoneReady, this.closed, this.monotonicNow());
    try {
      this.stream?.getAudioTracks().forEach(track => { track.enabled = enabled; });
    } catch {
      if (this.expiryTimer) clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
      this.transmitGate = { heldIntent: false, leaseValid: false, emergency: false };
      this.trackFailed = true;
      // A faulty enabled setter is no longer a trustworthy mute mechanism.
      // Stop the capture so the sender cannot keep carrying live audio.
      this.stream?.getTracks().forEach(track => { track.onended = null; try { track.enabled = false; } catch { /* stop is the final fallback */ } track.stop(); });
      if (!this.notifyingInvalidation) {
        this.notifyingInvalidation = true;
        try { this.onGateInvalidated?.('audio_track_failed'); } finally { this.notifyingInvalidation = false; }
      }
    }
  }
  async resumePlayback() { await this.audio.play(); }
  async createOffer() { if (this.closed) throw new Error('audio_closed'); const offer = await this.peer.createOffer(); if (this.closed) throw new Error('audio_closed'); await this.peer.setLocalDescription(offer); if (this.closed) throw new Error('audio_closed'); return offer.sdp!; }
  async acceptOffer(sdp: string) { if (this.closed) throw new Error('audio_closed'); await this.peer.setRemoteDescription({ type: 'offer', sdp }); if (this.closed) throw new Error('audio_closed'); const answer = await this.peer.createAnswer(); if (this.closed) throw new Error('audio_closed'); await this.peer.setLocalDescription(answer); if (this.closed) throw new Error('audio_closed'); return answer.sdp!; }
  async acceptAnswer(sdp: string) { if (this.closed) throw new Error('audio_closed'); await this.peer.setRemoteDescription({ type: 'answer', sdp }); }
  async addIce(candidate: RTCIceCandidateInit) { if (this.closed) return; if (this.peer.remoteDescription) await this.peer.addIceCandidate(candidate); else { if (this.pendingIce.length >= 256) throw new Error('ice_queue_limit'); this.pendingIce.push(candidate); } }
  async flushIce() { if (!this.peer.remoteDescription || this.closed) return; const pending = this.pendingIce.splice(0); for (const candidate of pending) { if (this.closed) return; await this.peer.addIceCandidate(candidate); } }
  private pendingIce: RTCIceCandidateInit[] = [];
  close() { this.closed = true; ++this.revision; if (this.expiryTimer) clearTimeout(this.expiryTimer); this.expiryTimer = undefined; this.setTransmitting(false); navigator.mediaDevices.removeEventListener('devicechange', this.deviceChanged); this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.pendingIce = []; this.peer.close(); this.audio.srcObject = null; this.onRemote?.(false); }
  get connected() { return !this.closed && this.peer.connectionState === 'connected' && !['disconnected', 'failed', 'closed'].includes(this.peer.iceConnectionState); }
  get microphoneReady() { return !this.closed && !this.trackFailed && Boolean(this.stream?.getAudioTracks().some(track => track.readyState === 'live')); }
}
