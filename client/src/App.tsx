import { useEffect, useRef, useState, type FormEvent } from 'react';
import { listen } from '@tauri-apps/api/event';
import { AudioSession, type AudioDevices } from './lib/audio';
import { SignalingClient, type SignalingEvent } from './lib/signaling';
import { canAcceptFloorGrant, initialPttState, pttReducer, type PttEvent, type PttTriggerSource } from './lib/ptt';
import { developmentSignalingUrl, getSignalingUrlOverride, resetSignalingUrlOverride, resolveSignalingConfig, saveSignalingUrlOverride } from './lib/config';

type Room = { displayName: string; roomCode: string; invitationToken: string; role: 'creator' | 'joiner' };
type MediaContext = {
  client: SignalingClient;
  generation: number;
  session: AudioSession;
  ready: Promise<void>;
  resolveReady: () => void;
  readyForNegotiation: boolean;
  epoch?: number;
  cancelled: boolean;
};
const monotonicNow = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

export default function App() {
  const buildSignalingUrl = import.meta.env.VITE_SIGNALING_URL;
  const development = import.meta.env.DEV;
  const [config, setConfig] = useState(() => resolveSignalingConfig(buildSignalingUrl, development));
  const [serverUrl, setServerUrl] = useState(() => getSignalingUrlOverride() ?? (buildSignalingUrl?.trim() || (development ? developmentSignalingUrl : '')));
  const [displayName, setDisplayName] = useState(''); const [roomCode, setRoomCode] = useState(''); const [invite, setInvite] = useState('');
  const [room, setRoom] = useState<Room | null>(null); const [error, setError] = useState(''); const [status, setStatus] = useState('Offline');
  const [ptt, setPtt] = useState(initialPttState); const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [] });
  const [inputId, setInputId] = useState(''); const [outputId, setOutputId] = useState(''); const [remoteAudio, setRemoteAudio] = useState(false); const [remoteSpeaking, setRemoteSpeaking] = useState(false);
  const signaling = useRef<SignalingClient | undefined>(undefined); const audio = useRef<AudioSession | undefined>(undefined); const pttRef = useRef(ptt);
  const inputIdRef = useRef(inputId); inputIdRef.current = inputId;
  const outputIdRef = useRef(outputId); outputIdRef.current = outputId;
  const leaseRef = useRef<{ leaseId: string; sessionId: string; requestId: string; generation: number; client: SignalingClient; epoch: number; expiresAt: number; deadline: number } | undefined>(undefined);
  const pendingRequest = useRef<{ id: string; requestId: number; sessionId: string; generation: number; epoch: number; client: SignalingClient; requestedAt: number } | undefined>(undefined);
  const mediaRef = useRef<MediaContext | undefined>(undefined);
  const signalQueue = useRef<{ generation: number; context: MediaContext; tail: Promise<void> } | undefined>(undefined);
  const pressed = useRef(false);
  const heldSources = useRef(new Set<string>());
  const inputRevision = useRef(0);
  const roomEventRef = useRef<Extract<SignalingEvent, { type: 'room' }> | undefined>(undefined);
  const mounted = useRef(true);

  // Safety events must update the intent latch before React's batched render.
  function dispatch(event: PttEvent) {
    pttRef.current = pttReducer(pttRef.current, event);
    if (mounted.current) setPtt(pttRef.current);
  }

  function isCurrent(client: SignalingClient, generation: number, context?: MediaContext) {
    return mounted.current && signaling.current === client && client.currentGeneration === generation && (!context || (mediaRef.current === context && !context.cancelled));
  }

  function syncTransmitGate() {
    const session = audio.current;
    const state = pttRef.current;
    const lease = leaseRef.current;
    const leaseValid = Boolean(lease && lease.client === signaling.current && lease.generation === signaling.current?.currentGeneration && lease.epoch === mediaRef.current?.epoch && lease.epoch === signaling.current?.currentEpoch && lease.deadline > monotonicNow() && state.phase === 'transmitting');
    session?.setTransmitGate({ heldIntent: pressed.current && state.phase === 'transmitting', leaseValid, leaseDeadline: lease?.deadline, emergency: state.emergency });
  }

  function clearPendingRequest() {
    pendingRequest.current = undefined;
  }

  function releaseActiveLease(client = signaling.current) {
    const lease = leaseRef.current;
    pressed.current = false;
    clearPendingRequest();
    leaseRef.current = undefined;
    // Mute synchronously before touching the socket. WebSocket.send can throw
    // while a reconnect is being torn down.
    try { audio.current?.setTransmitGate({ heldIntent: false, leaseValid: false, emergency: pttRef.current.emergency }); } catch { /* the audio session remains fail-closed */ }
    if (lease) {
      try { lease.client.speaking(lease.leaseId, false, lease.epoch); } catch { /* release is best effort after the local mute */ }
      try { lease.client.releaseFloor(lease.leaseId, lease.epoch); } catch { /* release is best effort after the local mute */ }
    }
    if (client || audio.current) syncTransmitGate();
  }

  function clearLocalLease(event: 'release' | 'deny') {
    leaseRef.current = undefined;
    clearPendingRequest();
    pressed.current = false;
    try { audio.current?.setTransmitGate({ heldIntent: false, leaseValid: false, emergency: pttRef.current.emergency }); } catch { /* fail closed */ }
    syncTransmitGate();
    dispatch({ type: event });
  }

  function cancelMedia() {
    const context = mediaRef.current;
    mediaRef.current = undefined;
    if (context) {
      context.cancelled = true;
      context.resolveReady();
      context.session.close();
    } else {
      audio.current?.close();
    }
    audio.current = undefined;
    signalQueue.current = undefined;
  }

  function enqueueNegotiation(context: MediaContext, generation: number, epoch: number, operation: () => Promise<void>) {
    if (!isCurrent(context.client, generation, context)) return;
    if (!signalQueue.current || signalQueue.current.context !== context || signalQueue.current.generation !== generation) signalQueue.current = { context, generation, tail: Promise.resolve() };
    const queue = signalQueue.current;
    queue.tail = queue.tail.then(async () => {
      await context.ready;
      if (!isCurrent(context.client, generation, context) || !context.readyForNegotiation || context.epoch !== epoch || context.client.currentEpoch !== epoch || !context.session.microphoneReady) return;
      try {
        await operation();
      } catch {
        if (isCurrent(context.client, generation, context) && context.epoch === epoch && context.client.currentEpoch === epoch) {
          setError('WebRTC negotiation failed');
          releaseActiveLease(context.client);
          pressed.current = false;
          dispatch({ type: 'disconnect' });
        }
      }
    });
  }

  useEffect(() => {
    mounted.current = true;
    const safety = () => { if (pttRef.current.triggerSource === 'ui') { pressed.current = false; releaseActiveLease(); } dispatch({ type: 'focus-loss' }); }; const hidden = () => { if (document.hidden) { if (pttRef.current.triggerSource === 'ui') { pressed.current = false; releaseActiveLease(); } dispatch({ type: 'hidden' }); } };
    const releasePointer = () => release('ui'); const releaseNative = () => release('global-shortcut'); const pressNative = () => press('global-shortcut');
    const offline = () => { releaseActiveLease(); dispatch({ type: 'disconnect' }); };
    const key = (event: KeyboardEvent) => { const target = event.target as HTMLElement | null; const editable = target?.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(target?.tagName ?? ''); if (event.key === 'Escape') { pressed.current = false; releaseActiveLease(); dispatch({ type: 'emergency' }); } if (event.code === 'Space' && !editable) { event.preventDefault(); if (!event.repeat) press('ui'); } };
    const keyup = (event: KeyboardEvent) => { if (event.code === 'Space') release('ui'); };
    window.addEventListener('blur', safety); document.addEventListener('visibilitychange', hidden); window.addEventListener('pointerup', releasePointer); window.addEventListener('pointercancel', releasePointer); window.addEventListener('offline', offline); window.addEventListener('pagehide', offline); window.addEventListener('keydown', key); window.addEventListener('keyup', keyup);

    let disposed = false;
    const nativeUnlisteners: Array<() => void> = [];
    const listenForTauri = async (eventName: string, handler: () => void) => {
      try {
        const unlisten = await listen(eventName, handler);
        if (disposed) unlisten();
        else nativeUnlisteners.push(unlisten);
      } catch {
        // The event API is unavailable in a regular browser; DOM listeners above are the fallback.
      }
    };

    // Tauri exposes this marker only in its webview. Avoid probing the native
    // event bridge in browser builds, while keeping the same PTT paths below.
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void listenForTauri('shortcut://pressed', pressNative);
      void listenForTauri('shortcut://released', releaseNative);
      void listenForTauri('window://blurred', safety);
      void listenForTauri('window://close-requested', safety);
      void listenForTauri('window://destroyed', safety);
    }

    return () => { disposed = true; mounted.current = false; nativeUnlisteners.splice(0).forEach(unlisten => unlisten()); releaseActiveLease(); pressed.current = false; cancelMedia(); signaling.current?.disconnect(); signaling.current = undefined; window.removeEventListener('blur', safety); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pointerup', releasePointer); window.removeEventListener('pointercancel', releasePointer); window.removeEventListener('offline', offline); window.removeEventListener('pagehide', offline); window.removeEventListener('keydown', key); window.removeEventListener('keyup', keyup); };
  }, []);
  useEffect(() => { syncTransmitGate(); }, [ptt]);
  useEffect(() => { if (ptt.phase === 'off') releaseActiveLease(); }, [ptt.phase]);

  async function enter(event: FormEvent, mode: 'create' | 'join') {
    event.preventDefault();
    if (!config.ok) { setError(config.error); return; }
    setError(''); if (!displayName.trim() || (mode === 'join' && (!roomCode.trim() || !invite.trim()))) { setError('Enter your display name, room code, and invitation token.'); return; }
    releaseActiveLease(); pressed.current = false; dispatch({ type: 'leave' }); cancelMedia(); signaling.current?.disconnect(); signaling.current = undefined;
    const client = new SignalingClient(config.url); signaling.current = client; setStatus('Connecting…');
    client.on((message: SignalingEvent) => { const generation = client.currentGeneration; void onSignaling(message, mode, client, generation); });
    mode === 'create' ? client.create() : client.join(roomCode.trim().toUpperCase(), invite.trim());
  }
  async function onSignaling(message: SignalingEvent, mode: 'create' | 'join', client: SignalingClient, generation: number) {
    if (!isCurrent(client, generation)) return;
    if (message.type === 'state') {
      setStatus(message.state);
      if (message.state === 'idle' || message.state === 'closed') {
        releaseActiveLease(client);
        pressed.current = false;
        cancelMedia();
        setRemoteAudio(false);
        setRemoteSpeaking(false);
        dispatch({ type: 'disconnect' });
      }
      return;
    }
    if (message.type === 'error') { releaseActiveLease(client); pressed.current = false; cancelMedia(); setRemoteAudio(false); setRemoteSpeaking(false); setError(message.code === 'signaling_start_failed' ? 'Could not start the signaling connection. Check VITE_SIGNALING_URL and browser security settings, then try again.' : message.code === 'signaling_unavailable' ? 'Signaling server unavailable. Check your network and the configured signaling endpoint (including TLS); reconnecting automatically.' : message.code); dispatch({ type: 'disconnect' }); return; }
    if (message.type === 'floor_busy') { if (pendingRequest.current?.client !== client || message.id !== pendingRequest.current?.id) return; releaseActiveLease(); dispatch({ type: 'deny' }); setError('Someone else is speaking'); return; }
    if (message.type === 'floor_granted') {
      if (message.epoch !== mediaRef.current?.epoch) return;
      if (leaseRef.current?.leaseId === message.leaseId) return;
      const pending = pendingRequest.current;
      const deadline = pending ? pending.requestedAt + message.leaseDurationMs : NaN;
      const accepted = canAcceptFloorGrant(message, pending, pttRef.current, pressed.current, monotonicNow())
        && pending?.client === client
        && message.generation === generation && audio.current?.connected;
      if (accepted && pending) {
        pendingRequest.current = undefined;
        const lease: NonNullable<typeof leaseRef.current> = { leaseId: message.leaseId, sessionId: message.sessionId, requestId: message.id!, generation, client, epoch: message.epoch, expiresAt: message.expiresAt, deadline };
        leaseRef.current = lease;
        try { client.speaking(message.leaseId, true, message.epoch); } catch { releaseActiveLease(); dispatch({ type: 'deny' }); return; }
        dispatch({ type: 'grant', requestId: pending.requestId });
        syncTransmitGate();
      } else if (message.sessionId === client.currentSessionId) {
        // A grant without the echoed request id cannot be correlated safely.
        try { client.releaseFloor(message.leaseId, message.epoch); } catch { releaseActiveLease(); dispatch({ type: 'deny' }); }
        if ((message.id === undefined || message.id === pending?.id) && pending?.client === client && pending.generation === generation) {
          clearLocalLease('deny');
        }
      }
      return;
    }
    if (message.type === 'floor_released') {
      const lease = leaseRef.current;
      if (message.epoch !== mediaRef.current?.epoch) return;
      if (lease?.sessionId === message.sessionId && lease.client === client && lease.epoch === message.epoch && lease.leaseId === message.leaseId) clearLocalLease('release');
      if (message.sessionId !== client.currentSessionId) setRemoteSpeaking(false);
      return;
    }
    if (message.type === 'floor_expired') {
      const lease = leaseRef.current;
      if (message.epoch !== mediaRef.current?.epoch) return;
      if (lease?.sessionId === message.sessionId && lease.client === client && lease.epoch === message.epoch && lease.leaseId === message.leaseId) clearLocalLease('deny');
      if (message.sessionId !== client.currentSessionId) setRemoteSpeaking(false);
      return;
    }
    if (message.type === 'speaking') { if (message.epoch === mediaRef.current?.epoch && message.sessionId !== client.currentSessionId) setRemoteSpeaking(message.speaking); return; }
    if (message.type === 'room') {
      roomEventRef.current = message;
      releaseActiveLease(client);
      dispatch({ type: 'release' });
      pressed.current = false;
      cancelMedia();
      setRemoteAudio(false); setRemoteSpeaking(false);
      const nextRoom: Room = { displayName: displayName.trim(), roomCode: message.roomCode, invitationToken: message.invitationToken ?? invite.trim(), role: mode === 'create' ? 'creator' : 'joiner' }; setRoom(nextRoom); setInvite(nextRoom.invitationToken);
      let resolveReady!: () => void;
      const ready = new Promise<void>(resolve => { resolveReady = resolve; });
      let session!: AudioSession;
      const context: MediaContext = { client, generation, session: undefined as unknown as AudioSession, ready, resolveReady, readyForNegotiation: false, cancelled: false };
      const active = () => isCurrent(client, generation, context);
      session = new AudioSession(
        candidate => { if (active() && context.epoch !== undefined) client.sendSignal('ice', JSON.stringify(candidate), context.epoch); },
        connected => { if (active()) { setRemoteAudio(connected); if (!connected) { releaseActiveLease(client); dispatch({ type: 'release' }); } syncTransmitGate(); } },
        { iceServers: message.iceServers ?? [] },
        failure => { if (active()) { setError(failure); dispatch({ type: 'gates', connected: pttRef.current.connected, inRoom: true, micReady: session.microphoneReady }); } },
        reason => { if (active()) { releaseActiveLease(client); dispatch({ type: 'release' }); dispatch({ type: 'gates', connected: pttRef.current.connected, inRoom: true, micReady: session.microphoneReady }); if (reason === 'peer_disconnected') setRemoteAudio(false); } },
      );
      context.session = session;
      mediaRef.current = context;
      audio.current = session;
      try {
        await session.prepare(inputIdRef.current || undefined);
        if (!active()) { session.close(); return; }
        const nextDevices = await session.devices();
        if (!active()) { session.close(); return; }
        setDevices(nextDevices);
        if (outputIdRef.current) {
          try { await session.setOutput(outputIdRef.current); } catch { if (active()) setError('Output device unavailable'); }
          if (!active()) { session.close(); return; }
        }
        dispatch({ type: 'gates', connected: true, inRoom: true, micReady: session.microphoneReady });
        context.readyForNegotiation = true;
        context.resolveReady();
        client.ready();
      } catch (cause) {
        if (!active()) { session.close(); return; }
        context.resolveReady();
        setError(cause instanceof DOMException && cause.name === 'NotAllowedError' ? 'Microphone permission denied' : 'Microphone unavailable');
        dispatch({ type: 'gates', connected: true, inRoom: true, micReady: false });
      }
      return;
    }
     if (message.type === 'peer_left') {
       releaseActiveLease(client);
       pressed.current = false;
       cancelMedia();
       setRemoteAudio(false);
       setRemoteSpeaking(false);
       dispatch({ type: 'gates', connected: true, inRoom: true, micReady: false });
       return;
     }
    if (message.type === 'peer_ready') {
      if (mediaRef.current?.epoch !== undefined && roomEventRef.current) void onSignaling(roomEventRef.current, mode, client, generation);
      const context = mediaRef.current;
      if (!context || context.client !== client || context.generation !== generation) return;
      context.epoch = message.epoch;
      if (message.offerer) enqueueNegotiation(context, generation, message.epoch, async () => {
        const offer = await context.session.createOffer();
        if (isCurrent(client, generation, context) && context.epoch === message.epoch && client.currentEpoch === message.epoch) client.sendSignal('offer', offer, message.epoch);
      });
      return;
    }
    if (message.type === 'signal') {
      const context = mediaRef.current;
      if (!context || context.client !== client || context.generation !== generation) return;
      if (context.epoch !== message.epoch) return;
      enqueueNegotiation(context, generation, message.epoch, async () => {
        if (message.kind === 'offer') {
          const answer = await context.session.acceptOffer(message.payload);
          if (isCurrent(client, generation, context) && context.epoch === message.epoch && client.currentEpoch === message.epoch) client.sendSignal('answer', answer, message.epoch);
        } else if (message.kind === 'answer') {
          await context.session.acceptAnswer(message.payload);
        } else {
          await context.session.addIce(JSON.parse(message.payload) as RTCIceCandidateInit);
        }
        if (isCurrent(client, generation, context) && context.epoch === message.epoch && client.currentEpoch === message.epoch) await context.session.flushIce();
      });
    }
  }
  async function changeInput(id: string) {
    const revision = ++inputRevision.current;
    releaseActiveLease();
    pressed.current = false;
    dispatch({ type: 'release' });
    setInputId(id);
    inputIdRef.current = id;
    const context = mediaRef.current;
    try {
      await context?.session.setInput(id);
      if (!context || revision !== inputRevision.current || !isCurrent(context.client, context.generation, context)) return;
      context.readyForNegotiation = true;
      context.resolveReady();
      context.client.ready();
      dispatch({ type: 'gates', connected: pttRef.current.connected, inRoom: true, micReady: context.session.microphoneReady });
    } catch {
      if (revision !== inputRevision.current || !context || !isCurrent(context.client, context.generation, context)) return;
      setError('Microphone unavailable');
      dispatch({ type: 'disconnect' });
    }
  }
  async function changeOutput(id: string) { setOutputId(id); outputIdRef.current = id; const context = mediaRef.current; try { await context?.session.setOutput(id); } catch { if (context && isCurrent(context.client, context.generation, context)) setError('Output device unavailable'); } }
  function press(source: Exclude<PttTriggerSource, null> = 'ui') {
    if (heldSources.current.has(source)) return;
    heldSources.current.add(source);
    if (pressed.current) return;
    const current = pttRef.current;
    const client = signaling.current;
    const epoch = mediaRef.current?.epoch;
    if (current.phase === 'off' && current.connected && current.inRoom && current.micReady && !current.emergency && client && epoch !== undefined && client.currentEpoch === epoch && audio.current?.connected) {
      pressed.current = true;
      audio.current.setTransmitGate({ heldIntent: true, leaseValid: false, emergency: current.emergency });
      if (!pressed.current || !audio.current.microphoneReady) { releaseActiveLease(); dispatch({ type: 'deny' }); return; }
      dispatch({ type: 'press', source });
      const requestedAt = monotonicNow();
      try {
        const requestId = client.requestFloor(epoch);
        if (!requestId) { releaseActiveLease(); dispatch({ type: 'deny' }); return; }
        pendingRequest.current = { id: requestId, requestId: current.requestId + 1, sessionId: client.currentSessionId, generation: client.currentGeneration, epoch, client, requestedAt };
      } catch { releaseActiveLease(); dispatch({ type: 'deny' }); }
    }
  }
  function release(source: Exclude<PttTriggerSource, null> = 'ui') {
    heldSources.current.delete(source);
    if (pttRef.current.triggerSource !== source) return;
    pressed.current = false;
    releaseActiveLease();
    dispatch({ type: 'release', source });
  }
  function leave() { releaseActiveLease(); pressed.current = false; dispatch({ type: 'leave' }); cancelMedia(); signaling.current?.disconnect(); signaling.current = undefined; setRoom(null); setStatus('Offline'); setRemoteAudio(false); setRemoteSpeaking(false); }

  function saveServerSettings() {
    const saved = saveSignalingUrlOverride(serverUrl);
    const next = resolveSignalingConfig(buildSignalingUrl, development);
    setConfig(next);
    if (!saved) setError('Could not save the signaling URL override.');
    else if (!next.ok) setError(next.error);
    else setError('');
  }
  function resetServerSettings() {
    const reset = resetSignalingUrlOverride();
    const nextUrl = buildSignalingUrl?.trim() || (development ? developmentSignalingUrl : '');
    setServerUrl(nextUrl);
    const next = resolveSignalingConfig(buildSignalingUrl, development);
    setConfig(next);
    if (!reset) setError('Could not reset the signaling URL override.');
    else if (!next.ok) setError(next.error);
    else setError('');
  }

     return <main className="shell"><header><div className="brand">TALKIE</div><span className={status === 'joined' ? 'status online' : 'status'}>● {status}</span></header>
     {!config.ok && <p role="alert" className="error">{config.error}</p>}
     {room ? <section className="card room" aria-label="Room"><p className="eyebrow">PRIVATE ROOM · {room.role.toUpperCase()}</p><h1>{room.roomCode}</h1><p className="muted">Welcome, {room.displayName}. Share this room code and invitation token with one person.</p><div className="invite"><label htmlFor="invite">Invitation token</label><input id="invite" value={room.invitationToken} readOnly /><button className="secondary" type="button" onClick={() => void navigator.clipboard?.writeText(`talkie://join?room=${room.roomCode}&token=${encodeURIComponent(room.invitationToken)}`)}>Copy invitation</button></div>
        <ul className="readiness"><li>Signaling: {status}</li><li>Microphone: {ptt.phase === 'transmitting' ? 'transmitting' : ptt.micReady ? 'ready (muted)' : 'not ready'}</li><li>Peer connection: {remoteAudio ? 'connected' : 'waiting'}</li><li>Remote speaker: {remoteSpeaking ? 'speaking' : 'silent'}</li></ul>
        <button className="secondary" type="button" onClick={() => { void audio.current?.resumePlayback().catch(() => setError('Remote playback blocked. Check the output device and try Enable audio again.')); }}>Enable audio</button>
      <div className="devices"><label htmlFor="input-device">Microphone</label><select id="input-device" value={inputId} onChange={event => void changeInput(event.target.value)}><option value="">Default microphone</option>{devices.inputs.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Microphone'}</option>)}</select><label htmlFor="output-device">Speaker</label><select id="output-device" value={outputId} onChange={event => void changeOutput(event.target.value)}><option value="">Default speaker</option>{devices.outputs.map(device => <option key={device.deviceId} value={device.deviceId}>{device.label || 'Speaker'}</option>)}</select></div>
        <div className="ptt-panel"><span className="ptt-label">PUSH TO TALK · {ptt.phase.toUpperCase()}</span><button className={`ptt ${ptt.phase === 'transmitting' ? 'active' : ''}`} disabled={!ptt.connected || !ptt.inRoom || !ptt.micReady || ptt.emergency} onPointerDown={() => press()} onPointerUp={() => release()} onPointerCancel={() => release()} onPointerLeave={() => release()} aria-describedby="ptt-help">{ptt.phase === 'transmitting' ? 'Speaking' : 'Hold to talk'}</button><small id="ptt-help">Microphone stays muted until the server grants the floor. Esc or focus loss stops transmission.</small><button className="secondary" onClick={() => { pressed.current = false; releaseActiveLease(); dispatch({ type: ptt.emergency ? 'clear-emergency' : 'emergency' }); }}>{ptt.emergency ? 'Clear emergency stop' : 'Emergency stop · Esc'}</button></div>{error && <p role="alert" className="error">{error}</p>}<button className="link-button" onClick={leave}>Leave room</button>
     </section> : <section className="card"><p className="eyebrow">PRIVATE VOICE ROOMS</p><h1>Talk when it matters.</h1><p className="muted">Create a room or join with an invitation token. Audio is peer-to-peer and never recorded.</p><details className="server-settings"><summary>Server Settings</summary><p className="muted">Effective signaling URL: <code>{config.ok ? config.url : 'not configured'}</code></p><label htmlFor="signaling-url">Signaling URL</label><input id="signaling-url" value={serverUrl} onChange={event => setServerUrl(event.target.value)} placeholder="wss://signal.example.com" autoComplete="off" /><div className="actions"><button className="primary" type="button" onClick={saveServerSettings}>Save</button><button className="secondary" type="button" onClick={resetServerSettings}>Reset</button></div></details><form onSubmit={event => void enter(event, 'join')}><label htmlFor="display-name">Display name</label><input id="display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={40} placeholder="Your name" required /><label htmlFor="room-code">Room code <span className="optional">for join</span></label><input id="room-code" value={roomCode} onChange={event => setRoomCode(event.target.value)} maxLength={6} placeholder="ABC123" autoComplete="off" /><label htmlFor="join-token">Invitation token <span className="optional">for join</span></label><input id="join-token" value={invite} onChange={event => setInvite(event.target.value)} placeholder="Private invitation token" autoComplete="off" />{error && <p role="alert" className="error">{error}</p>}<div className="actions"><button className="primary" type="button" disabled={!config.ok} onClick={event => void enter(event, 'create')}>Create room</button><button className="secondary" type="submit" disabled={!config.ok}>Join room</button></div></form></section>}<footer>Peer-to-peer audio <span>•</span> No recording</footer></main>;
}
