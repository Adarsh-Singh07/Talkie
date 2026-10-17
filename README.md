# Talkie

Talkie is an ultra-lightweight, zero-account, one-to-one desktop walkie-talkie for Windows. It combines a native Tauri shell with WebRTC audio and strict server-mediated Push-to-Talk floor control, so you can coordinate without a full Discord or Teams session running in the background.

## Why Talkie

Talkie is designed for quick, low-latency voice coordination while:

- co-working or pair programming;
- watching a stream or video together;
- gaming with a small trusted group; or
- coordinating a remote task without an always-open meeting room.

Only one participant owns the speaking floor at a time. Audio is muted by default, media is peer-to-peer when possible, and Talkie does not record microphone audio.

## Features

- Six-character uppercase room codes; no invitation-token copy/paste.
- Native Windows global Push-to-Talk that continues to work while another app is focused.
- Customizable keyboard shortcut with a tactile keycap recorder.
- P2P WebRTC audio with Cloudflare Worker signaling and optional Cloudflare Realtime TURN.
- Compact native Windows installer, typically around 3–5 MB.
- Microphone and speaker selection with a restrained diagnostics drawer.
- No account, no contact list, no recording, and no audio mixer.

## Quick start for users

1. Download **[Talkie_0.2.0_x64-setup.exe](https://github.com/Adarsh-Singh07/Talkie/releases/tag/v0.2.0)** from Releases.
2. Install Talkie on both Windows laptops.
3. On the first laptop, enter your display name and select **Create Room**.
4. Share the six-character room code with the second person.
5. On the second laptop, enter a display name, type the code, and select **Join Room**.
6. Hold the Push-to-Talk pad or the configured global shortcut to speak.

The current hosted signaling endpoint is the Cloudflare Worker deployed for the release. The installer contains the endpoint configuration; users do not need Node.js, Rust, Wrangler, or Cloudflare credentials.

## Build and verify from source

Requirements:

- Node.js 22 or newer;
- Rustup with the pinned toolchain in `rust-toolchain.toml`;
- Visual Studio Build Tools 2022 with Desktop development with C++ and the Windows SDK; and
- WebView2 on the target Windows machine.

From the repository root:

```powershell
npm ci
npm run typecheck
npm test
npm run test:contract
npm run test:build-config
```

Build the client and Windows package with a real public endpoint:

```powershell
$env:VITE_SIGNALING_URL = "wss://talkie-signaling.adarsh2001gop.workers.dev"
npm run tauri -- build -- --locked
npm run verify:windows
```

Outputs are written to:

- `src-tauri/target/release/talkie.exe`
- `src-tauri/target/release/bundle/nsis/Talkie_0.2.0_x64-setup.exe`

For local development, run the Node signaling server and Vite client separately:

```text
npm run dev:server
npm run dev:client
```

Development uses `ws://127.0.0.1:8787`. Packaged builds require an explicit public `wss://` endpoint or a validated runtime override in Server Settings.

## Architecture

| Layer | Technology | Responsibility |
| --- | --- | --- |
| Desktop shell | Tauri 2 + Rust | Windows window, global shortcut, lifecycle, packaging |
| UI | React + TypeScript | Onboarding, room controls, device settings, PTT intent |
| Media | WebRTC in WebView2 | Encrypted DTLS-SRTP microphone audio |
| Signaling | Cloudflare Worker + Durable Object | Room code registry, resume state, SDP/ICE relay, floor leases |
| Traversal | Cloudflare Realtime TURN | Optional relay fallback for restrictive networks |

The signaling service never mixes or records audio. It coordinates the two peers and authorizes the speaking floor. The Cloudflare Worker lives in `cloudflare-worker/`; the Node server in `server/` remains available for local development and self-hosting.

## Cloudflare deployment

From `cloudflare-worker/`, authenticate Wrangler and deploy:

```powershell
npx wrangler login
npm ci
npm run typecheck
npm test
npx wrangler secret put ALLOWED_ORIGINS
npx wrangler deploy
```

For Cloudflare Realtime TURN, keep `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` as Worker secrets. They never belong in `VITE_*` values, the desktop build, or committed files.

## Security and privacy

- Room codes are uppercase six-character identifiers and are checked against active room state before assignment.
- Resume tokens are private per-session credentials and are retained only as hashes until room expiry.
- The server owns floor admission, lease expiry, release, and disconnect cleanup.
- Microphone tracks are disabled unless the local hold, valid floor lease, peer connection, and safety gates all agree.
- Talkie does not record or persist microphone audio.

See [the release flow](docs/release-flow.md), [deployment notes](docs/deployment.md), [testing guide](docs/testing.md), and [wire protocol](server/PROTOCOL.md) for operational details.
