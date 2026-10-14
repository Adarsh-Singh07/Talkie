# Testing

## Current status

The current suite has **204 tests**: 121 client (including 34 mounted React cases and 56 configuration cases) and 83 server. The original 110-test baseline is documented in [release-audit.md](release-audit.md). Current remote-trial status is in [trial-deployment.md](trial-deployment.md). A separate real client/server signaling contract runs over loopback. The Windows candidate job is now gated on a verified public endpoint; no validation-fixture build is uploaded.

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
npm run test:contract
npm run test:build-config
npm run build --workspace talkie-signaling-server
npm run test:production
```

Production client and native builds require an actual public endpoint in
`VITE_SIGNALING_URL`, in addition to Rust, the Windows SDK, WebView2 and Tauri CLI.
`npm run test:build-config` proves the real Vite build rejects missing, insecure
and local-TLS endpoints. CI also runs a validation-only compile with an explicit
syntax fixture; it is never a release artifact.

```text
npm run tauri -- info
npm run verify:public
npm run tauri -- build -- --locked
npm run verify:windows
```

For a public probe with Cloudflare Realtime TURN, provide both
`CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` only through the process environment.
The probe then validates the Cloudflare credential response and requires a
credentialed TURN entry from the public room; it never prints either value and
does not claim that a media allocation succeeded. Supplying neither variable
leaves the probe at its normal direct/STUN-or-configured-TURN checks.

CI must use deterministic mocks and must not print secrets.

TURN tests verify HMAC-SHA1 credential generation, future expiry, TTL/room bounds,
per-recipient freshness, admission checks, and shared-secret exclusion from all
response payloads. The optional public probe can validate Cloudflare credential
issuance, but neither path proves an external TURN allocation succeeds.

## Environment-bound verification

Still required on Windows with two clients: microphone permission and unplugging, Bluetooth profile changes, global shortcut conflicts, lock/sleep/resume, direct ICE, UDP-blocked TURN over TCP/TLS, WebView2 runtime installation, NSIS install/upgrade/uninstall, and signed-artifact launch.
