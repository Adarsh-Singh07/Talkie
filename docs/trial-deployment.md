# Existing-host remote trial: configuration and current blocker

## Status: BLOCKED — selected host is not reachable over SSH

The baseline at `adcad3d` and its successful Windows CI were verified before
continuing. No interrupted deployment had completed: the working tree was clean,
there were no repository deployment records, secrets or endpoint variables, and
only the baseline CI run existed.

The owner explicitly rejected new paid infrastructure and selected the existing
SSH alias **`hermes`**, rather than the separate Azure/Elektrix production host.
Two read-only SSH attempts timed out at TCP port 22 before authentication. The
selected host's OS, available capacity, services, public IP assignment, firewall,
DNS and actual cloud provider therefore remain **unverified**. Do not apply Azure
NSG commands merely because an earlier description called the VM Azure.

No cloud resources, public IPs, volumes, ports, tunnels, services, DNS records,
secrets, or firewall changes were created. Existing services were not restarted.
No public signaling endpoint or live TURN relay can be claimed.

## Verified configuration map

| Purpose | Exact setting/path | Behavior |
| --- | --- | --- |
| Desktop signaling URL | `VITE_SIGNALING_URL`; `client/src/lib/config.ts`, `App.tsx` | Compiled by Vite, **not runtime configurable** in the installer |
| Vite env loading | `client/vite.config.ts`, `envDir: '..'` | Root `.env`, mode-specific Vite env files, or process environment; process env takes precedence |
| Production enforcement | `resolveSignalingConfig` in `client/src/lib/config.ts` | Builds require explicit public WSS; missing, blank, WS, local/private/reserved IPs, placeholder domains, userinfo and fragments rejected; runtime error also blocks create/join |
| Development | Vite dev mode | Missing URL uses `ws://127.0.0.1:8787`; this fallback is never used in a packaged production build |
| Public build record | `client/dist/talkie-build.json` | Emitted public endpoint and build-time configuration marker; no TURN secrets |
| Desktop network policy | `src-tauri/tauri.conf.json`, `app.security.csp` | WSS allowed; local WS limited to loopback; IPC and media allowed. Narrow WSS to actual deployment host when it becomes known |
| Node binding | `HOST`, `PORT` in `server/src/index.ts` | Defaults loopback:8787. Node itself serves HTTP/WS, not TLS |
| Production/origins | `NODE_ENV=production`, `ALLOWED_ORIGINS` | Nonempty exact origins required; Windows packaged origin is `http://tauri.localhost`; not a substitute for room authorization |
| TLS/WSS | External TLS proxy/tunnel | Must have a publicly trusted certificate and WebSocket upgrade support; no insecure TLS bypass |
| STUN | `STUN_URL` | Optional single URI from server process env; `.env.example` lists Google's public STUN, but Node has no implicit STUN default |
| TURN endpoints | `TURN_URL` | Comma-separated validated `turn:`/`turns:` URIs; actual listener and firewall must exist |
| Temporary TURN signing | **New:** `TURN_SHARED_SECRET` | At least 32 UTF-8 bytes; server/coturn only; never a `VITE_*` value or client response |
| Temporary TURN lifetime | **New:** `TURN_CREDENTIAL_TTL_SECONDS` | Default 3900; at least room TTL + 60, at most 86400 seconds |
| Legacy static TURN | `TURN_USERNAME`, `TURN_CREDENTIAL` | Development only; rejected in production or mixed with dynamic settings |
| ICE delivery | `server/src/ice.ts` → authenticated room acknowledgements → `App.tsx` → `AudioSession` | Existing `iceServers` array passed into `RTCPeerConnection`; room/floor/negotiation protocol unchanged |

New TURN mode issues `<unixExpiry>:<randomNonce>` usernames and base64 HMAC-SHA1
credentials compatible with coturn REST auth. All relay endpoints must share the
same server-side secret. Acknowledgement recipients get separate temporary
credentials only after admission. The default lifetime covers the fixed one-hour
room without adding an ICE-refresh protocol. Keep clocks synchronized. These are
temporary bearer credentials, not a guarantee against relay abuse; quotas and
bounded relay bandwidth are still required. Issuance is implemented/tested;
actual TURN allocation is **not tested**.

## Ports proposed — none opened

Do not execute firewall changes until the actual host is inspected and the owner
has reviewed the exact rules. No production web/admin port will be taken over.

| Use | Direction/ports | Reason |
| --- | --- | --- |
| Existing administration | Existing inbound TCP 22, restricted to the administrator source | Restore the existing authorized SSH route only; do not allow public-wide SSH |
| Signaling container | Private bridge or host loopback TCP 8787 | Tunnel/proxy to Node; no public binding required |
| Cloudflare HTTP tunnel | Outbound TCP/UDP 7844 (transport dependent); outbound HTTPS 443 for control/bootstrap | WSS signaling without a new inbound web port; provider/network policy still needs inspection |
| Optional direct coturn | Public UDP/TCP 3478 on **existing** IP | Authenticated TURN/STUN listener, not an HTTP tunnel |
| Optional TURN/TLS | Public TCP 5349 with valid certificate | TLS relay for networks permitting that port; do not steal an occupied TCP 443 |
| Optional relay range | Public UDP 49160–49179 | Small relay allocation range for a two-person trial; match coturn and cloud/host firewall rules |

A Quick Tunnel is suitable only for temporary signaling evaluation. Its hostname
can change after restart, requires an internet-connected tunnel process, and is
not a TURN UDP endpoint. A changed hostname requires rebuilding the installer
with the new URL. An existing named tunnel/subdomain is preferred if authorized
DNS access is available. Neither type has been created here.

## Budget and isolation constraints

- No GCP project/VM, no new paid service, no new public IP/storage, no resizing.
- No Hermes/Elektrix restart, overwrite, compose recreation, port takeover or
  global Docker prune. Use a separate reviewed directory and Compose project.
- A proposed lightweight signaling service can be capped at 0.5 CPU/128–256 MiB;
  a separate tunnel also needs a measured cap. These are planning bounds, not
  verified capacity on the unreachable host.
- Reusing a VM does **not** prove zero incremental cost: provider outbound
  bandwidth, TURN relay traffic and log/disk usage may still be billable. Verify
  existing allowances first. If additional charges/resource changes are possible,
  stop for owner approval; no resource or cost assumption authorizes spending.
- Cap container logs (`max-size`, `max-file`), node socket/room/rate budgets,
  coturn allocation/bandwidth quotas and relay ports. Never log message bodies,
  environment values or issued credentials. Block TURN relay to private/admin
  networks. Exact limits and rules depend on the host inspection.

## Exact next actions for the owner

From the Windows machine (no password/key/token should be pasted into chat):

```powershell
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 hermes hostname
```

If this still times out, use the existing provider's VM/serial console to confirm
that the VM is running and its **current** public address matches your local SSH
alias. Confirm whether a VPN/bastion or administrator-source allowlist is needed.
Do not disable host-key checks, restart production services, or open SSH to the
whole internet. Correct the alias locally if the old IP is stale.

Run these **read-only** commands in that host's console and provide non-secret
results (redact unrelated domains/paths if desired):

```sh
hostname
uname -srmo
cat /etc/os-release
uptime
free -m
df -h /
ip -brief address
ss -lntu
systemctl list-units --type=service --state=running --no-pager
sudo -n docker ps --format '{{.Names}} | {{.Image}} | {{.Ports}}'
sudo -n docker stats --no-stream --format '{{.Name}} | {{.CPUPerc}} | {{.MemUsage}}'
sudo -n ufw status verbose
sudo -n iptables -S INPUT
sudo -n iptables -S DOCKER-USER
command -v cloudflared
```

Some utilities/rules may not exist; that is information, not permission to install
or modify the host. Do not provide `docker inspect` environment dumps, entire
compose/env files, SSH keys, tunnel tokens, or cloud access tokens. If you have a
Cloudflare-managed test subdomain, provide only its name and the authorized
management path, not credentials.

## Resume sequence after access is restored

1. Inspect the **selected host**, not the rejected Azure/Elektrix host. Verify
   capacity, existing services, firewall, provider identity, cost allowance and DNS.
2. Present the actual port/resource plan. Prefer a private signaling container
   with an isolated outbound tunnel, so existing 80/443 services stay untouched.
3. Start with public STUN/direct ICE; evaluate coturn on the same existing public
   IP only if ports, quotas, certificate and egress allowance are approved.
4. Provision a high-entropy TURN signing secret only on the host, readable only
   by Talkie/coturn. Do not transmit it through chat, GitHub variables, or client
   build settings. Shared-secret mode is optional for a STUN-only first test.
5. Verify actual HTTPS `/health`, WSS upgrades and room/floor protocol. From the
   workspace root, with the real public endpoint in the process environment:

   ```powershell
   npm run verify:public
   # If a relay was configured, require bounded credentials in the probe:
   npm run verify:public -- --require-turn
   ```

   The probe checks issuance structure/expiry, not real TURN allocation or audio.
6. Only then set the repository's public `VITE_SIGNALING_URL` variable to that
   verified endpoint and run the existing Windows workflow. Do not place any
   server-side secret in that variable. The candidate job checks public health/
   WSS before bundling and includes `talkie-build.json` plus checksums.
7. Give both testers the **same endpoint-configured** private artifact. Use
   headphones, permit the microphone, create/join with room code/token, and
   verify silence at idle, bidirectional held PTT and immediate release. Continue
   the hardware/network checklist in the baseline audit; none is presumed passed.

## Verification boundary

Local tests may validate HMAC generation, expiry, credential non-disclosure,
config selection and failed connections. A validation-only production compile
uses a syntactically valid fixture domain and is **never** a deployable installer.
Until SSH/deployment is restored, public health, WSS, live TURN and a new real-
endpoint Windows installer remain **BLOCKED**, not successful.

### Local verification completed for this continuation

- `npm ci`: PASS, installed from the existing root lockfile.
- `npm run typecheck`: PASS.
- `npm test`: PASS, **204 tests** (121 client + 83 server).
- `npm run test:contract`: PASS against real local ws sockets; connection-loss
  notifications are expected for the three deliberate disconnects.
- `npm run test:build-config`: PASS; missing/blank, WS and local WSS builds fail
  with actionable errors rather than falling back to loopback.
- `npm run build`: PASS **only as a validation compile**, with an explicitly
  marked syntax fixture endpoint. Its output is ignored by Git and not published.
- `npm run test:production`: PASS for the compiled local server's `/health`.
- Temporary TURN issuance: PASS in live local WebSocket tests, with deterministic
  HMAC/expiry checks and no shared secret in responses.
- `client/src/lib/audio.ts` and `ptt.ts`: unchanged from the audited baseline.
- Existing baseline native artifact hashes were checked and are unchanged.
  No new installer was built with the validation fixture or relabeled as remote-ready.
