# Talkie

Talkie is a Windows push-to-talk desktop MVP. Two participants join a private room and exchange live microphone audio directly over WebRTC. The signaling service coordinates room membership and WebRTC negotiation; it does not carry, record, or persist audio.

> **Status:** reliability-audited trial build, not a production release. Automated media-safety and live signaling tests pass; an unsigned Windows x64 executable and NSIS installer have been built and launch-tested. Two-PC voice, global hotkey in games, lock/sleep, and TURN tests are still outstanding. See [the release report](docs/release-audit.md).

## Target architecture

| Area | Planned technology | Responsibility |
| --- | --- | --- |
| Desktop client | Tauri 2, React, TypeScript, WebView2 | UI, device permissions, WebRTC, PTT state |
| Native shell | Rust/Tauri | global shortcut, lifecycle, focus, safe shutdown |
| Signaling | Node.js, TypeScript, `ws` | rooms, authorization, SDP/ICE relay, heartbeats |
| Media | WebRTC in WebView2 | encrypted DTLS-SRTP audio using Opus |
| Traversal | STUN + coturn TURN | direct connectivity and relay fallback |

The server is not an audio mixer. Media is peer-to-peer when possible and relayed by TURN when direct connectivity fails.

## Repository layout

```text
client/                 React/TypeScript desktop UI
  src/App.tsx           home/room UI and session lifecycle
  src/lib/              media gate, audio, PTT, signaling
  src/test/             deterministic browser/media fakes
server/                 Node/TypeScript signaling service
  src/                  protocol, room manager, security, server
  test/                 protocol and room integration tests
src-tauri/              Tauri/Rust shell and capabilities
  src/                  native commands and lifecycle handling
  capabilities/         least-privilege Tauri permissions
docs/                   architecture, operations, tests, support
scripts/                live signaling, production startup, PE verification
```

## Security and lifecycle baseline

- A room code identifies a room, but a private, short-lived invitation capability authorizes a join.
- The server authorizes every room and signaling operation and never trusts client-supplied speaking state.
- PTT is a server-authoritative floor lease with a transmission ID, expiry, maximum duration, and automatic release on disconnect.
- WebSocket and WebRTC reconnection use separate connection generations so stale messages cannot affect a new connection.
- DOM/native focus and close events, hidden document, disconnect, leave, and microphone failure invalidate local intent and the actual audio gate. Lock/sleep/resume require real Windows validation; do not infer those results from mocked events.
- Each hold has a hard 30-second lease by default, with a conservative monotonic client deadline. No lease renewal or automatic resumption is implemented.
- Private resume credentials prevent a token-holding peer from taking over another participant's session ID. Only credential hashes persist in memory until room expiry.
- Production signaling must use WSS. TURN credentials are configured on the server and necessarily shared with joined clients; automatic short-lived TURN issuance is **not implemented**. Use limited-lifetime trial credentials and quotas.

See [the architecture review](docs/architecture-review.md) for risks, decisions still required, and acceptance criteria.

## Local setup

Requirements: Node.js 22+. From the repository root:

```text
npm ci
npm run typecheck
npm test
npm run build
npm run test:contract
npm run test:production
```

In separate terminals run `npm run dev:server` and `npm run dev:client`. The browser UI is at `http://localhost:5173`; signaling defaults to `ws://127.0.0.1:8787`. Space is focused PTT; Ctrl+Shift+Space is native global PTT. Escape latches emergency mute. Use headphones and a separate room code/token field for joining (OS invitation-link activation is not implemented).

For configuration, copy `.env.example` to an untracked root `.env`. Vite reads root client variables; the server deliberately reads the process environment. After `npm run build`, start an env-configured server from the root with `node --env-file=.env server/dist/src/index.js`. Never put TURN secrets in `VITE_*` values. A remote trial installer needs `VITE_SIGNALING_URL=wss://your-signaling-host` set **before** the client/Tauri build; the default installer connects to the local machine only.

## Windows build

Install Rustup and Visual Studio Build Tools 2022 with Desktop development with C++ and Windows SDK. WebView2 is required at runtime; Tauri downloads its verified NSIS tooling as needed. Rust is pinned by `rust-toolchain.toml` and dependencies by `src-tauri/Cargo.lock`.

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH" # if this terminal predates Rust installation
npm run tauri -- info
npm run tauri -- build -- --locked
npm run verify:windows
```

Outputs: `src-tauri/target/release/talkie.exe` and `src-tauri/target/release/bundle/nsis/Talkie_0.1.0_x64-setup.exe`. They are **unsigned**; signing and clean-machine validation are separate release gates. GitHub Actions builds and uploads private CI artifacts, not public releases.

## Documentation

- [Architecture review and decisions](docs/architecture-review.md)
- [Deployment](docs/deployment.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release audit, results and manual checklist](docs/release-audit.md)
- [Wire protocol](server/PROTOCOL.md)

## Privacy boundary

Talkie does not record or persist microphone audio. Initial server room state is in memory only. Signaling logs must redact invitation tokens, SDP, ICE credentials, and session secrets.
