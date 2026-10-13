# Deployment

## Current status

The application and signaling service are implemented, and CI runs typechecks, tests, and client/server builds. Production deployment remains conditional on TURN, Windows hardware, code signing, and installer validation described below.

## Intended production topology

Client A and client B each use WSS to the Node signaling service. Their audio
travels **between the clients**, directly or through coturn, never through Node.

Deploy signaling and coturn separately from the desktop client. Put WSS behind a TLS-terminating proxy. The MVP keeps room state in memory; a server restart ends active rooms.

## Production requirements

- Node.js 22+; `npm ci`, `npm run build --workspace talkie-signaling-server`, then `npm start --workspace talkie-signaling-server`.
- HTTPS/WSS with a valid certificate.
- TURN over UDP plus TCP/TLS fallback; test TCP/TLS on port 443.
- The current server forwards configured TURN username/password; it does not mint or refresh expiring credentials. Supply limited trial credentials, quotas, and expiry at coturn. Never commit them or log authenticated room acknowledgements.
- Restricted `ALLOWED_ORIGINS`, rate limits, message-size limits, and redacted logs.
- Firewall rules exposing only WSS and required TURN ports.

## Release checklist

1. Pin Node, Rust, Tauri, and WebView2-supported versions.
2. Configure values from `.env.example` through a secret store.
3. Run server tests and TURN connectivity tests.
4. Build the signed Windows x64 NSIS installer on `windows-latest`.
5. Test install, permission, global PTT, upgrade, and uninstall on a clean VM.
6. Record artifact checksums, release version, rollback steps, and compatibility.

Do not call the deployment production-ready until direct, TURN-relayed, reconnect, and UDP-blocked scenarios have been tested.

## Actual configuration and boundaries

- Production startup requires nonempty `ALLOWED_ORIGINS`; include `http://tauri.localhost` for this Windows WebView origin and any explicitly deployed web UI. Origin is defense-in-depth, not authorization (non-browser clients can forge it).
- `.env` is not implicitly loaded by Node. Export configuration through the service manager, or use `node --env-file=.env server/dist/src/index.js` from the root.
- `/health` is a basic process-health endpoint. It does not prove TURN or voice readiness.
- Node listens without TLS behind a TLS proxy. Bind `HOST=127.0.0.1` on a single-host deployment and proxy WebSocket upgrades. No wildcard origin is needed.
- The socket IP, not `X-Forwarded-For`, is trusted for budgets. Behind a reverse proxy, per-IP quotas apply to that proxy's shared address; configure edge rate limits and size the Node aggregate budget accordingly.
- Room code format is six uppercase characters, not the original eight-character example. Tokens are reusable until the fixed room TTL (default one hour); empty rooms remain available for reconnect until that TTL.
- Session/resume tokens live only in client memory and server hashes; application restart is a new identity. The floor is a hard maximum hold (default 30 seconds), not a renewable lease.
- Plain WS is allowed in the desktop CSP only for local loopback development; WSS is required for remote endpoints. Set `VITE_SIGNALING_URL` before packaging, and restrict `connect-src wss:` to the deployment host when shipping a dedicated production build.
- The service controls membership and speaking metadata, not encrypted P2P packets. A deliberately modified authorized client can bypass its own track mute; this is not a hostile-peer media moderation system.
