# Talkie

Talkie is a Windows push-to-talk desktop MVP. Two participants join a private room and exchange live microphone audio directly over WebRTC. The signaling service coordinates room membership and WebRTC negotiation; it does not carry, record, or persist audio.

> **Status:** the baseline `adcad3d` Windows installer passed its local build/launch audit. A controlled CI candidate can embed an operator-supplied public WSS endpoint, run the public probe, and retain checksummed unsigned artifacts. A tagged GitHub release is published only after the real endpoint and live probe gates pass. Public deployment, TURN allocation, physical two-PC audio, signing, and clean-machine validation remain unverified; access to the selected existing host is still blocked. See [the controlled release flow](docs/release-flow.md), [trial deployment status](docs/trial-deployment.md), and [the baseline release report](docs/release-audit.md).

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
cloudflare-worker/      Cloudflare Worker + Durable Object signaling service
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
- Production signaling must use WSS. Coturn REST or Cloudflare Realtime TURN credentials are obtained server-side after room admission and expire; server credentials are never sent to the clients. A live TURN allocation has not yet been tested.

See [the architecture review](docs/architecture-review.md) for risks, decisions still required, and acceptance criteria.

## Local setup

Requirements: Node.js 22+. From the repository root:

```text
npm ci
npm run typecheck
npm test
npm run test:contract
npm run test:build-config
```

In separate terminals run `npm run dev:server` and `npm run dev:client`. The browser UI is at `http://localhost:5173`; signaling defaults to `ws://127.0.0.1:8787`. Space is focused PTT; Ctrl+Shift+Space is native global PTT. Escape latches emergency mute. Use headphones and a separate room code/token field for joining (OS invitation-link activation is not implemented).

For configuration, copy `.env.example` to an untracked root `.env`. Vite reads root client variables; the server deliberately reads the process environment. After a server build, start an env-configured server from the root with `node --env-file=.env server/dist/src/index.js`. Never put TURN or Cloudflare credentials in `VITE_*` values. A remote trial installer needs the verified public endpoint in `VITE_SIGNALING_URL` **before** the client/Tauri build; only the historical baseline installer defaults to the local machine.

**Configuration change after the baseline build:** new production builds require
an explicitly configured, real public `wss://` endpoint and reject localhost or
missing configuration. Only Vite development mode retains the loopback default.
The installed executable also has a **Server Settings** panel. It can save a
runtime WSS override in local storage, validated with the same public-WSS rules;
the override takes precedence over the compiled endpoint for that installation.
Reset removes the override and returns to the compiled value. This is useful for
an authorized endpoint change, but it does not deploy or verify a server. The
public `client/dist/talkie-build.json` records which endpoint was compiled; it
contains no TURN credentials.

## Windows build

Install Rustup and Visual Studio Build Tools 2022 with Desktop development with C++ and Windows SDK. WebView2 is required at runtime; Tauri downloads its verified NSIS tooling as needed. Rust is pinned by `rust-toolchain.toml` and dependencies by `src-tauri/Cargo.lock`.

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH" # if this terminal predates Rust installation
npm run tauri -- info
npm run tauri -- build -- --locked
npm run verify:windows
```

Outputs: `src-tauri/target/release/talkie.exe` and `src-tauri/target/release/bundle/nsis/Talkie_0.1.0_x64-setup.exe`. They are **unsigned**; signing and clean-machine validation are separate release gates. The Windows workflow validates pull requests without a candidate, accepts a dispatch `signaling_url` (then the repository variable, then a clearly marked safe example), and publishes the installer, portable executable, checksums, and build metadata only for `v*` tags after the live probe succeeds. A safe example or an explicitly skipped probe cannot publish a tagged release.

## Documentation

- [Architecture review and decisions](docs/architecture-review.md)
- [Deployment](docs/deployment.md)
- [Testing](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release audit, results and manual checklist](docs/release-audit.md)
- [Wire protocol](server/PROTOCOL.md)
- [Existing-host trial deployment and access blocker](docs/trial-deployment.md)
- [Controlled Windows release flow and public deployment options](docs/release-flow.md)

## Privacy boundary

Talkie does not record or persist microphone audio. Initial server room state is in memory only. Signaling logs must redact invitation tokens, SDP, ICE credentials, and session secrets.
