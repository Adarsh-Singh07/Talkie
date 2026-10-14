# Controlled Windows release flow

## What CI does

The workflow in `.github/workflows/build-windows.yml` has three deliberately
separate paths:

1. Pull requests run tests, contract checks, build-configuration checks, and a
   validation-only client compile using a safe example WSS hostname. That
   hostname is syntax-only; it is not a deployment and no installer is
   published.
2. `workflow_dispatch` runs the unsigned candidate job. Its optional
   `signaling_url` input has highest priority, followed by the repository
   variable `VITE_SIGNALING_URL`. If neither is supplied, CI uses
   `wss://signal.talkie-validation-fixture.net/rooms` only as a clearly marked
   syntax fallback. The live probe runs unless `skip_live_probe` is explicitly
   set to `true`. An explicitly skipped probe produces a validation artifact,
   not a release.
3. A `v*` tag runs the same candidate job and then publishes a GitHub Release.
   Tagged runs reject the safe fallback and cannot skip the live probe. The
   release contains the unsigned NSIS installer, portable executable,
   `artifact-checksums.jsonl`, `talkie-build.json`, and `release-metadata.json`.
   The compiled endpoint is recorded in `talkie-build.json`; the metadata also
   records whether the endpoint came from a dispatch input or repository
   variable. Publication uses `softprops/action-gh-release@v2` with
   `contents: write` scoped to the release job.

The candidate never receives a server TURN shared secret. Optional Cloudflare
probe credentials are read only from GitHub Actions secrets and are used only by
the probe step. No credential belongs in a repository variable, `VITE_*` value,
artifact, build metadata file, or log.

## Deploy the Node signaling service

Talkie’s signaling implementation is a Node.js `http`/`ws` service, not a
Cloudflare Worker bundle. Deploy it as a long-running Node process (or a
container) with an external TLS/WSS proxy. The service keeps room state in
memory, so a restart ends active rooms. Use the values in `.env.example`, set
`NODE_ENV=production`, provide a nonempty exact `ALLOWED_ORIGINS` list including
`http://tauri.localhost`, and keep the process bound to a private interface.

After building the server, start it with the process environment available:

```sh
npm run build --workspace talkie-signaling-server
node --env-file=.env server/dist/src/index.js
```

Verify `GET /health` through the public TLS proxy, then run the WSS room probe
from a network that can reach the public hostname. `/health` proves process
health only; it does not prove WebRTC, TURN allocation, microphone access, or
Windows behavior.

### Cloudflare Worker + Durable Object option

The repository also contains a separate Worker implementation under
`cloudflare-worker/`. It stores room and identity state in a SQLite-backed
Durable Object and handles `/health` and the Talkie WebSocket protocol directly;
it is not a proxy for the Node process. The Worker implementation has its own
configuration surface and should be tested independently from the root Node
service.

From that directory, install its dependencies, run its checks, and deploy with
Wrangler after authenticating to the intended Cloudflare account:

```sh
cd cloudflare-worker
npm install
npm run typecheck
npm test
npx wrangler secret put ALLOWED_ORIGINS
npx wrangler deploy
```

Set `STUN_URL`, `TURN_URL`, and the dynamic coturn values through Wrangler
environment variables/secrets as appropriate. Keep `TURN_SHARED_SECRET` in a
secret, and never put it in the desktop build. The Worker can also mint
short-lived Cloudflare Realtime TURN credentials when both `CF_TURN_KEY_ID` and
`CF_TURN_API_TOKEN` are configured as Worker secrets; it caches successful ICE
responses briefly and falls back to the configured STUN/coturn entries when the
Cloudflare request fails. The Durable Object migration in `wrangler.toml` is
part of the deployment; do not reuse its namespace for an unreviewed
environment.

Do not claim a Worker deployment is live until its public `/health`, WSS
handshake, create/join, signal relay, and floor-control checks pass. The current
selected existing host is still blocked by unavailable SSH access, so no Worker
or public origin has been deployed by this repository.

## Cloudflare Realtime TURN setup

Cloudflare Realtime TURN is optional. The server supports it with two
server-only environment values:

```text
CF_TURN_KEY_ID=<Cloudflare TURN key identifier>
CF_TURN_API_TOKEN=<short-lived or tightly scoped API token>
```

Provision a Cloudflare API token with the permission required to generate
Realtime TURN credentials. Keep the key identifier and token in the signaling
service’s secret store; do not put them in `VITE_*`, the Windows workflow’s
repository variables, the desktop app, or logs. The server requests short-lived
ICE credentials from Cloudflare after room admission and forwards only the
credentialed ICE entries to the two participants. If the Cloudflare request
fails, the implementation returns no Cloudflare ICE entries and does not print
the response or token.

Cloudflare TURN setup still requires the Cloudflare account/service to be
enabled, clocks and network policy to permit the relay, and a restrictive
network test. Cloudflare credential issuance is not the same as a successful
UDP/TCP/TLS media allocation.

To validate the account credentials and the public room’s TURN issuance, supply
both values only in the probe process environment:

```powershell
$env:CF_TURN_KEY_ID = '<value from the secret store>'
$env:CF_TURN_API_TOKEN = '<value from the secret store>'
npm run verify:public
Remove-Item Env:CF_TURN_KEY_ID, Env:CF_TURN_API_TOKEN
```

The probe validates the Cloudflare API response only when both variables are
present, requires a credentialed TURN entry in the public room when they are
present, and never logs either value. It does not allocate media, test a
UDP-blocked network, or prove audio.

The alternative coturn REST mode remains supported through `TURN_URL` and
`TURN_SHARED_SECRET`. Its secret is also server-only and must not be mixed into
the client build.

## Tailscale Funnel option

For a temporary signaling-only evaluation, an authorized, internet-connected
host can expose the loopback Node service through Tailscale Funnel. Keep Node
bound to `127.0.0.1:8787`, use the stable Funnel HTTPS hostname as the basis for
the client endpoint (`wss://<host>.ts.net/<path>`), and verify both `/health` and
WebSocket upgrades before building the installer. The exact Funnel command and
TLS behavior depend on the installed Tailscale version and tailnet policy; use
the vendor-supported command for forwarding local port `8787` and keep the
Funnel hostname stable for the lifetime of the build.

Funnel is an HTTPS/WSS path for signaling, not a TURN relay. It requires the
host and Tailscale service to stay online, can be restricted by tailnet policy,
and does not solve UDP-blocked peer media. It is not a substitute for coturn or
Cloudflare TURN, and it has not been exercised in this repository.

## Truthful release blockers

The automated checks prove configuration policy, server protocol behavior, and
artifact structure. They do not prove:

- a deployed public origin or a live Cloudflare Worker/Tailscale Funnel;
- successful TURN allocation on UDP, TCP, or TLS under restrictive networks;
- real microphone permissions, WebView2 behavior, latency, or two-PC audio;
- lock/sleep/resume and global shortcut behavior on Windows hardware;
- clean-machine installation or upgrade behavior; or
- Authenticode signing and SmartScreen reputation.

Until those checks are performed with a real endpoint and suitable Windows
hardware, the published artifact (if the controlled tag gates pass) is an
unsigned, endpoint-configured candidate—not a claim of production readiness.
