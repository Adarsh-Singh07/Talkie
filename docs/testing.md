# Testing

## Current status

The reliability suite has 110 tests: 53 client (including 25 mounted React media-path integration cases) and 57 server. A separate real client/server signaling contract smoke runs over loopback. See [release-audit.md](release-audit.md) for actual results, failures fixed, artifacts, and the PASS/FAIL/BLOCKED/NOT TESTED checklist. The Windows workflow builds and uploads an unsigned installer; signing is not configured.

## Required automated coverage

### Client and PTT

Test that PTT starts off, cannot start outside a connected room, toggles one persistent track rather than recreating a peer connection, and resets on key/mouse release, focus loss, hidden document, disconnect, microphone failure, emergency mute, leave, shutdown, and repeated short presses. Include stale transmission IDs and stuck-key prevention.

### WebRTC controller

Mock browser WebRTC APIs to verify one microphone track, `enabled=false` initially, remote audio while local audio is off, candidate buffering, generation rejection, and track stop on leave.

`client/src/App.integration.test.tsx` mounts the actual App/AudioSession with deterministic WebSocket and WebRTC fakes and inspects attached sender tracks. `audio.test.ts` exercises gate expiry, disconnect, failed setters, capture replacement and remote-track independence. These are not physical audio/WebView2 tests.

### Signaling server

Test room creation/join authorization, invalid and expired invitations, two-person capacity, schema and size limits, offer/answer/ICE relay, heartbeat timeout, disconnect cleanup, room expiry, rate limits, replay/stale-generation rejection, floor lease, duplicate release, and maximum transmission duration.

### Windows/manual matrix

On two Windows clients test same-LAN and different-network calls, TURN relay, UDP-blocked TCP/TLS TURN, microphone denial/removal, Bluetooth changes, focus loss, lock/sleep/resume, global shortcut conflicts, close/quit behavior, and clean installation.

## Current commands

```text
npm ci
npm run typecheck
npm test
npm run build
npm run test:contract
npm run test:production
```

The native installer command is available only on a machine with Rust, the Windows SDK, WebView2, and the Tauri CLI:

```text
npm run tauri -- info
npm run tauri -- build -- --locked
npm run verify:windows
```

CI must use deterministic mocks and must not print secrets.

## Environment-bound verification

Still required on Windows with two clients: microphone permission and unplugging, Bluetooth profile changes, global shortcut conflicts, lock/sleep/resume, direct ICE, UDP-blocked TURN over TCP/TLS, WebView2 runtime installation, NSIS install/upgrade/uninstall, and signed-artifact launch.
