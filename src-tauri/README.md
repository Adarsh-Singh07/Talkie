# Talkie native integration

The Tauri 2 shell registers `Space` by default through
`tauri-plugin-global-shortcut` at startup. The native handler emits these
events to the webview:

- `shortcut://pressed` and `shortcut://released` (payload: the active shortcut)
- `window://focused`, `window://close-requested`, and
  `window://destroyed` (payload: `null`)

The frontend can change the registered shortcut through the `set_global_shortcut`
command and use pressed/released events for floor control. The native side
intentionally does not own recording or microphone state. Window focus loss is
not a transmission safety reset: global PTT is designed to work while another
application is focused.

The plugin's Tauri 2 API reports both pressed and released states through its
Rust callback, so no polling or OS-specific Windows hook is needed. Shortcut
registration failures (including a shortcut already claimed by another
process) fail application setup rather than silently running without PTT.
The capability permits only core event listening/unlistening; shortcut
registration stays in Rust. Do not add
an empty `plugins.global-shortcut` config object: this plugin expects unit
configuration and an object prevents startup.

Rust 1.99.0 and MSVC/Windows SDK were installed for the release audit. The
Windows x64 release was compiled, bundled, launched, installed in a test
directory, relaunched, and uninstalled. See `docs/release-audit.md` for precise
scope. Those checks do not validate physical microphones, global key events
in games, workstation lock/sleep, or TURN connectivity.
