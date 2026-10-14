# Deployment

## Current status

The application and signaling service are implemented, and CI runs typechecks, tests, and client/server builds. Production deployment remains conditional on a reachable public origin, TURN, Windows hardware, code signing, and installer validation described below. See [the controlled release flow](release-flow.md) for the Worker proxy and Tailscale Funnel options.

## Intended production topology

Client A and client B each use WSS to the Node signaling service. Their audio
travels **between the clients**, directly or through coturn, never through Node.

Deploy signaling and coturn separately from the desktop client. Put WSS behind a TLS-terminating proxy. The MVP keeps room state in memory; a server restart ends active rooms.

## Production requirements

- Node.js 22+; `npm ci`, `npm run build --workspace talkie-signaling-server`, then `npm start --workspace talkie-signaling-server`.
- HTTPS/WSS with a valid certificate.
- TURN over UDP plus TCP/TLS fallback; test TCP/TLS on port 443.
- Production TURN uses coturn REST time-limited credentials issued after room admission. The new `TURN_SHARED_SECRET` stays on the signaling/coturn servers; it is never embedded in the desktop app or returned in an acknowledgement. Keep coturn quotas and credentials out of logs. See `server/PROTOCOL.md` for lifetime limits.
- Cloudflare Realtime TURN is also supported with the server-only `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` values. The public probe validates those credentials only when both are supplied and does not log them. Credential issuance does not prove a media allocation.
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
- `/health` is a basic process-health endpoint. It does not prove TURN or voice readiness. The separate `cloudflare-worker/` deployment uses a Durable Object and is not a proxy for this Node origin; neither deployment is publicly verified.
- Node listens without TLS behind a TLS proxy. Bind `HOST=127.0.0.1` on a single-host deployment and proxy WebSocket upgrades. No wildcard origin is needed.
- The socket IP, not `X-Forwarded-For`, is trusted for budgets. Behind a reverse proxy, per-IP quotas apply to that proxy's shared address; configure edge rate limits and size the Node aggregate budget accordingly.
- Room code format is six uppercase characters, not the original eight-character example. Tokens are reusable until the fixed room TTL (default one hour); empty rooms remain available for reconnect until that TTL.
- Session/resume tokens live only in client memory and server hashes; application restart is a new identity. The floor is a hard maximum hold (default 30 seconds), not a renewable lease.
- Plain WS is allowed in the desktop CSP only for local loopback development; WSS is required for remote endpoints. Set `VITE_SIGNALING_URL` before packaging, or use the validated Server Settings runtime override for an authorized endpoint change. A Tailscale Funnel can provide temporary WSS signaling to the loopback Node service, but it is not a TURN relay.
- The service controls membership and speaking metadata, not encrypted P2P packets. A deliberately modified authorized client can bypass its own track mute; this is not a hostile-peer media moderation system.

## Remote trial continuation

See [trial-deployment.md](trial-deployment.md) for the verified configuration map,
the existing-host-only budget rule, blocked SSH access, proposed ports, and
read-only commands to run on the host. **No public Talkie deployment is currently
verified.** A production build now refuses missing/insecure signaling URLs
instead of silently embedding localhost.

Windows CI separates a validation-only compile (with a clearly marked syntax
fixture) from the candidate job. Dispatch input `signaling_url` wins, then the
repository variable `VITE_SIGNALING_URL`, then the safe syntax-only example.
The candidate embeds the selected URL and validates HTTPS/WSS and room protocol
unless `skip_live_probe` is explicitly requested. A `v*` tag rejects the example
and skipped probe, then publishes the unsigned installer, portable executable,
build metadata, and checksums. Do not set the variable or input to an unverified
URL or server secret.
