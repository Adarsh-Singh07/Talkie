# Talkie native integration

The Tauri 2 shell registers `Ctrl+Shift+Space` through
`tauri-plugin-global-shortcut` at startup. The native handler emits these
events to the webview:

- `shortcut://pressed` and `shortcut://released` (payload: `Ctrl+Shift+Space`)
- `window://focused`, `window://blurred`, `window://close-requested`, and
  `window://destroyed` (payload: `null`)

The frontend can use the shortcut release and lifecycle events as safety-reset
signals for any in-progress push-to-talk state. The native side intentionally
does not own recording or microphone state.

The plugin's Tauri 2 API reports both pressed and released states through its
Rust callback, so no polling or OS-specific Windows hook is needed. Shortcut
registration failures (including a shortcut already claimed by another
process) fail application setup rather than silently running without PTT.
The current implementation uses the plugin's Rust registration API; no
frontend registration command is exposed. The capability permits only core
event listening/unlistening; shortcut registration stays in Rust. Do not add
an empty `plugins.global-shortcut` config object: this plugin expects unit
configuration and an object prevents startup.

Rust 1.99.0 and MSVC/Windows SDK were installed for the release audit. The
Windows x64 release was compiled, bundled, launched, installed in a test
directory, relaunched, and uninstalled. See `docs/release-audit.md` for precise
scope. Those checks do not validate physical microphones, global key events
in games, workstation lock/sleep, or TURN connectivity.
