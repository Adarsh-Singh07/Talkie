# Troubleshooting

## Starting or building

Run `npm ci` at the root. Use `npm run dev:server` and `npm run dev:client` in separate terminals. After building, `npm start --workspace talkie-signaling-server` uses `server/dist/src/index.js`. Native build instructions and unsigned artifact paths are in the README.

## Microphone permission denied

Confirm Windows microphone privacy settings allow desktop apps, then restart capture. The UI must show a distinct permission-denied state and must not enable PTT.

## Signaling connected but no audio

Check WebRTC ICE state and selected candidate pair. A connected WebSocket does not prove media connectivity. Test TURN credentials, firewall rules, and TCP/TLS fallback. Export only redacted diagnostics.

## PTT remains active

Use emergency mute. The implementation must also force PTT off on focus loss, hidden document, lock/sleep, microphone failure, peer/signaling disconnect, leave, and shutdown. Check that the server floor lease expires after heartbeat loss.

## Global shortcut does not register

The combination may be owned by another application or rejected by Windows. This version registers Ctrl+Shift+Space at startup and fails setup if registration fails. Close the conflicting application and retry. A configurable shortcut/error UI is not implemented. Do not run two Talkie native instances simultaneously on one PC for testing: they compete for the same global key.

## Native build or launch fails

- A terminal opened before Rust installation may need `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`.
- `npm run tauri -- info` must detect Rust, MSVC, Windows SDK, and WebView2. NSIS is downloaded by the bundler and verified.
- Use `npm run tauri -- build -- --locked`; the final `--locked` is a Cargo argument.
- Keep `src-tauri/icons/icon.ico` and the Cargo lockfile in source control.
- Do not add `plugins.global-shortcut: {}` to config; the native plugin expects no configuration and fails startup with that object.
- A responding window is only a launch smoke test, not proof of microphone permissions, network connectivity, or hotkey event delivery.

## Silent remote playback

Browser/WebView2 autoplay can reject playback. Click **Enable audio** in the room to retry playback from a user gesture. This affects the receiving audio element only and does not open the microphone. Select a valid output device. Real device behavior still needs Windows testing.

## Environment and issue reports

Use `.env.example` as the configuration reference. Never commit populated `.env` files, tokens, SDP, ICE credentials, or private keys. Include Windows version, app/server version, component, exact safe error, and clean-checkout reproduction status in reports.
