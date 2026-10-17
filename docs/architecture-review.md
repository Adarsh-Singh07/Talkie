# Architecture review

## Assessment

The proposed Tauri + WebView2 + WebRTC design is viable for a Windows MVP. It was not implementation-ready because signaling authorization, PTT ownership, reconnect generations, TURN operations, and Windows packaging behavior were underspecified.

## MVP baseline decisions

1. WebRTC audio is peer-to-peer or TURN-relayed; the signaling server never receives media.
2. The room code is the single join capability: six uppercase characters, generated from a non-ambiguous alphabet, checked for active-room uniqueness, and protected by room capacity and rate limits. Resume tokens remain private per-session credentials.
3. Every message has a protocol version, message ID, participant session ID, connection generation, and bounded payload. Mutating operations are idempotent where practical.
4. The server authoritatively grants a PTT floor lease with a transmission ID, expiry, maximum duration, and automatic release on disconnect or heartbeat timeout.
5. Signaling and WebRTC have separate state machines. Rejoin and renegotiation create a new connection generation; stale messages are rejected.
6. Use a deterministic offerer or perfect negotiation. Do not let both peers independently become offerer after reconnect.
7. Tauri exposes only the minimum capabilities for shortcuts and lifecycle. No arbitrary navigation, filesystem access, or generic native command is allowed.
8. Initially target Windows 10/11 x64, per-user NSIS, Evergreen WebView2, and signed release artifacts.

## Highest-risk items

### P0: signaling security

DTLS-SRTP encrypts media but does not authorize room membership. Validate the room-code capability, bind messages to a participant session, reject replay/stale generations, enforce capacity, and rate-limit connections, joins, and message sizes.

### P0: stuck PTT

Key-up can be lost during focus changes, sleep, lock, or process failure. Reset local PTT on every safety event, and expire floor leases when the client disappears. Press/release messages must carry a transmission ID so an old release cannot stop a later transmission.

### P0: TURN availability

STUN is not a relay. Production requires coturn or a managed TURN service with UDP, TCP, and TLS fallback, preferably TLS on port 443. Test restrictive networks before declaring success.

### P1: reconnect races

WebSocket connected does not mean media connected. Track signaling generation, peer-connection generation, ICE state, and candidate pair independently. Buffer candidates until the remote description exists and reject prior-generation events.

### P1: Windows lifecycle

Define close-to-tray versus quit, sleep/resume, workstation lock, single-instance behavior, shortcut registration failure, WebView2 availability, permission denial, and shutdown ordering before implementation.

## Decisions still required

- Floor lease, heartbeat, and maximum transmission durations.
- Reconnect backoff and maximum retry duration.
- Whether IP privacy requires relay-only mode.
- Microphone constraints and device-switch behavior.
- Code-signing certificate, installer ownership, and update policy.

## Definition-of-done additions

- Unauthorized, replayed, and stale signaling messages are rejected.
- Floor ownership is released after socket loss and lease expiry.
- Tests cover stale generations, duplicate releases, lost key-up, lock/sleep, and microphone removal.
- TURN works on a UDP-blocked network using TCP/TLS.
- A clean Windows machine installs and launches the signed artifact.
- Redacted diagnostics distinguish permission, signaling, ICE, TURN, and device failures.
