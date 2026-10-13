# Windows MVP reliability audit and build report

**Historical baseline: commit `adcad3d`.** The results and artifact hashes below
describe that local-loopback build. Current remote-trial changes and deployment
blockers are tracked in [trial-deployment.md](trial-deployment.md); do not mistake
this historical installer for a verified public-endpoint candidate.

## Decision: NOT READY for a remote two-person voice trial yet

The code/build work is verified below; this is **not** a claim that physical
voice, background global hotkeys, or TURN work on two Windows PCs. The local
unsigned installer is built and launches, but defaults to loopback signaling.
A remote trial needs a deployed WSS endpoint, an endpoint-configured build,
limited-lifetime TURN credentials, and the remaining manual checklist.

No audio recording or telemetry was added. The existing Talkie name and
Tauri/React/WebRTC/Node architecture were preserved.

## Audit findings and repairs

| Area | Defect found in the prior implementation | Repair/evidence |
| --- | --- | --- |
| Focused keyboard | Space had no key-up handler | Synchronous release; mounted App tests inspect the sender track |
| Late grants | Stale press grants could survive cancellation, React batching, or reconnect | Unique request ID + private session/generation + epoch + held intent required; id-less/late grants rejected |
| Release safety | Network send could throw before local mute | Mute and clear intent first; best-effort network release afterward |
| Media gate | Boolean enabling could outlive lease or PC state | Actual capture track gated by finite monotonic deadline, live mic, connected PC/ICE, valid lease and intent; expiry owned by AudioSession |
| PC recovery | Reconnected PC could retain old intent | Any uncertain PC/ICE state invalidates lease; fresh press required |
| Device lifecycle | Stale getUserMedia / replacement could affect a new session | Revision/context checks, stop abandoned tracks, await replaceTrack, fail-closed track-setter fallback |
| Peer reconnect | Remaining peer closed media and never rebuilt it | Fresh token-less joined acknowledgement refreshes media/readiness; negotiated epoch advances |
| Wire compatibility | Recipient generations and floor epochs were inconsistent | All floor traffic scoped to current epoch; exact lease IDs for release/expiry; real client/server contract smoke test |
| Session hijack | Shared invitation holder could replace another disclosed session ID | Separate random private resume proof, stored hashed; monotonic generations and bounded tombstones |
| Pre-join errors | Strict client ignored errors missing request generation | Echo validated request generation/epoch in error response |
| Expiry/resources | Expiry was traffic-dependent; stale sockets and ICE queues were unbounded in places | Proactive expiry, counted closing sockets, bounded room identities and pending ICE |
| Native build | Missing icon, serde_json, Manager import | Added required resources/dependency/import; compiled Windows release |
| Native startup | Empty global-shortcut config caused startup panic | Removed invalid plugin configuration; actual window launch passed |
| Native IPC/CSP | Missing event permissions and blocked signaling/IPC | Least-privilege event listen/unlisten permissions and constrained connect-src |
| Packaging | Server start script pointed at the wrong emitted file | Corrected dist/src/index.js; built production entry point smoke tested |
| Playback | Autoplay error suggested a nonexistent recovery control | User-gesture Enable audio retries receiver playback without requesting floor |

## Automated verification actually executed

| Command/check | Result | Evidence |
| --- | --- | --- |
| `npm ci` | PASS | Clean root-workspace dependency installation |
| `npm run typecheck` | PASS | Client and server TypeScript checks |
| `npm test` | PASS | 110 tests: 53 client + 57 server, eight files |
| `npm run test:contract` | PASS | Real SignalingClient and ws server over loopback; one/both drops, private resume, independent generations, floor and stale epoch filtering |
| `npm run build` | PASS | Vite production assets and server TypeScript output |
| `npm run test:production` | PASS | Built server process with NODE_ENV=production and valid origins; GET /health 200; child cleaned up |
| `npm audit --omit=dev` | PASS | 0 reported production npm vulnerabilities; not a complete dependency/security audit |
| `npm run tauri -- info` | PASS | Windows x64, Rust 1.99.0, Cargo 1.99.0, VS Build Tools 2022/MSVC, WebView2 detected |
| `npm run tauri -- build -- --locked` | PASS | Actual release compile and x64 NSIS bundle |
| `npm run verify:windows` | PASS | PE headers, byte counts, SHA-256 |
| Installer / executable smoke | PASS | Silent current-user install to isolated test path; responding Talkie window; normal close; uninstall removed executable |

Commands ran on Windows NT 10.0.26100 x64 with Node 22.19.0, npm 11.6.0,
WebView2 155.0.4283.45, Tauri 2.12.3, and global-shortcut plugin 2.4.1.
Rustup and the MSVC C++ build workload were installed with permission. An
interrupted Rust installation was repaired before compiling. NSIS 3.11 was
downloaded and hash-verified by Tauri. No global Git configuration was changed.

Earlier failures (before final green run): stale legacy protocol assertions,
missing native icon, Rust import/dependency errors, plugin configuration panic,
and missing root tsx install. These were fixed; no tests were skipped to obtain
the final passing result.

### What the tests prove, and what they do not

- 25 mounted React integration cases use the real App, SignalingClient, and
  AudioSession with fake browser media and WebSocket objects. They inspect
  `RTCRtpSender`'s attached track `enabled` state, not just a label.
- Tests cover release-before-grant, rapid holds, repeated native events, emergency
  and focus races, pointer cancellation/outside release, hidden document, native
  close, wall-clock changes, lease expiry, sender failures, ended devices,
  stale capture, one/both reconnects, and old queued offers.
- Media unit tests prove local mute does not disable the separate remote track.
- The real socket contract check does **not** transport WebRTC audio. Neither
  jsdom nor a fake peer proves WebView2 audio latency or Windows permission UX.
- Leases are deliberately not renewed. The 30-second default cap stops capture
  if no renewal arrives; no auto-renewal or auto-resume exists to test.
- Timer/event safety depends on the WebView event loop. Process hangs,
  suspend/resume, and desktop locking still require hardware/OS validation.

## Actual unsigned artifacts

| File | Bytes | Architecture / SHA-256 |
| --- | ---: | --- |
| `src-tauri/target/release/talkie.exe` | 4,294,656 | AMD64; `3da3e5ea0a1a845f6ebd7e6ed5510b01ccd3f6674eeb3b4b65ff5f4720c6df75` |
| `src-tauri/target/release/bundle/nsis/Talkie_0.1.0_x64-setup.exe` | 1,408,130 | x64 application payload, normal I386 NSIS bootstrapper; `74304778f48d2f85af62e3f9d1d07e636a003ff3b3f042474a48312c115b53a9` |

These are local build hashes; a CI rebuild can produce different hashes.
Build output is ignored by Git. CI uploads a private unsigned artifact; it
does not publish a GitHub Release or claim Authenticode signing.

## Real-world validation checklist

| Scenario | Status | Evidence / next check |
| --- | --- | --- |
| Two Windows PCs on different internet connections | BLOCKED | Only this build machine used; no second machine/network session supplied |
| Room create/join | PASS (automated) | Real client-to-server loopback contract and live ws tests; physical two-PC UX NOT TESTED |
| No outgoing capture at idle | PASS (automated) | Fake sender track disabled initially; physical remote listening NOT TESTED |
| PTT both directions | NOT TESTED | Needs two physical microphones/headsets and listening verification |
| Immediate release, cancellation, late grant | PASS (automated) | Actual fake sender track assertions; physical timing NOT TESTED |
| Global hotkey with another app focused | NOT TESTED | Native registration succeeded on launch; real pressed/released behavior not exercised |
| Full-screen movie and game | NOT TESTED | No full-screen/game session exercised |
| Reconnect while idle / transmitting | PASS (automated) | Mock media integration plus real sockets; physical network drop NOT TESTED |
| Microphone unplug/replug | NOT TESTED | Ended/devicechange simulated only |
| Bluetooth headset switching | NOT TESTED | No hardware switch performed |
| Windows lock, sleep, resume | NOT TESTED | No OS session manipulation performed |
| TURN on restrictive network | BLOCKED | No coturn endpoint/credentials or restrictive second network supplied |
| Installer installation | PASS | Final NSIS artifact installed silently in an isolated test directory, exit 0 |
| Installed executable launches and closes | PASS (smoke) | Responding window titled Talkie with nonzero native window handle; CloseMainWindow completed |
| Same-version reinstall | PASS | NSIS replacement smoke returned exit 0 |
| Upgrade from older released version | NOT TESTED | No prior released installer available |
| Uninstall | PASS | Silent uninstaller completed; installed talkie.exe no longer present |
| Clean machine without development dependencies | NOT TESTED | This machine has newly installed development tools; not a clean VM |
| Authenticode/SmartScreen distribution | BLOCKED | No signing identity provided; artifacts are unsigned |

## Remaining limitations / release gates

1. The endpoint embedded in the current build is loopback, not a deployed WSS
   service. Configure a real endpoint before giving an installer to a remote user.
2. TURN credentials are static configuration, not automatically issued ephemeral
   secrets. Joined clients must receive them for ICE; scope and expire them at
   the TURN service. This audit did not establish a TURN deployment.
3. Global shortcut is fixed Ctrl+Shift+Space. A registration conflict fails
   setup; there is no shortcut conflict recovery/settings UI. Close the owning
   application before running the trial.
4. No OS deep-link handler is registered for copied `talkie://` invitations.
   Use the room code/token fields. No tray, updater, or remote deployment is claimed.
5. No physical capture, remote listening, lock/sleep, or full-screen hotkey result
   can be inferred from a responding window or a TypeScript test.
6. The signaling server cannot police audio sent by a deliberately modified
   authorized P2P client. It refuses self-granted/foreign floor signaling, but
   the media gate is enforced by the distributed client, not an audio relay.
7. Direct ICE exposes network information to the invited peer; encryption is
   DTLS-SRTP transport security, not independently verified peer identity.

Next gate: configure a WSS/TURN trial environment, rebuild with that endpoint,
then have two Windows users execute this checklist. Mark each observed result;
do not promote the build based only on the automated passing suite.
