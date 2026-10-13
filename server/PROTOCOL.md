# Server protocol changes

All messages remain protocol version `v: 1`. Request IDs are socket-local and acknowledgements echo the initiating `id`. `generation` in server messages is the **recipient's** connection generation; peers may reconnect independently.

## Private session resumption

- Initial `create` and initial `join` fields are unchanged. A successful own `created` / `joined` acknowledgement now also contains a random `resumeToken`.
- Store that token privately alongside this room's invitation token, session ID, and generation. Do not put it in invitation links or forward it to a peer.
- Rejoining any previously used `sessionId` requires `{ v: 1, id, type: "join", roomCode, invitationToken, sessionId, generation, resumeToken }`. The room invitation remains mandatory. The generation must be a safe nonnegative integer strictly greater than that identity's last successful generation.
- Missing or incorrect resume proof returns `invalid_resume_token` without closing/replacing the existing session or changing its floor. A valid proof with a non-increasing generation returns `stale_generation`.
- Credentials remain valid until room expiry and do not rotate on successful resume. Only the SHA-256 hash is retained server-side. Disconnected identities remain tombstones until the original room TTL expires; reusing an old ID still requires its proof. A fresh session ID can join a free slot without a resume token.
- The other peer still receives the existing unsolicited `joined` event to rebuild audio. That event has no request ID, invitation token, or resume token. Clients must only save a resume token from their own ID-correlated acknowledgement.
- A room expires at its original deadline; joins do not extend TTL. Expiry proactively sends `{ v: 1, type: "error", generation, code: "room_expired" }` and closes both participant sockets with close code `1000` and reason `room_expired`.

**Required client follow-up:** retain the private acknowledgement token and include it when reconnecting the same session ID. Clearing the token means the old identity cannot be resumed. Ordinary first joins retain the original fields.

## Epoch-bound push-to-talk

`request_floor`, `release_floor`, and `speaking` now require `epoch`, a positive safe integer obtained from `peer_ready`. The floor is unavailable until both current participants are ready. Any inactive or stale epoch returns `stale_epoch` before floor state is changed.

- Request: `{ v: 1, id, type: "request_floor", generation, epoch }`.
- Grant to both peers: `{ v: 1, id, type: "floor_granted", generation, sessionId, epoch, leaseId, expiresAt, leaseDurationMs }`. `id` is the exact granting request ID. `expiresAt` is a server wall-clock timestamp; clients can enforce the local duration using `leaseDurationMs`.
- Release: `{ v: 1, id, type: "release_floor", generation, epoch, leaseId }`. A wrong, foreign, or already-released lease within a valid epoch is an idempotent no-op; it cannot release somebody else's floor.
- Speaking: `{ v: 1, id, type: "speaking", generation, epoch, leaseId, speaking }`. Only the actual current holder can update speaking; other leases return `invalid_floor_lease`, or `floor_expired` if no lease is active.
- Every `floor_released`, `floor_expired`, and `speaking` event includes its stored `epoch` and `leaseId`. Request-driven release and speaking events echo the triggering ID. Disconnect/replacement release and timer expiry events have no request ID.
- Leaving/replacing either peer invalidates the active floor and readiness. A subsequent two-ready negotiation advances the room epoch. Old-epoch expiry events are never emitted into a new epoch. Clients must scope incoming floor events by generation, epoch, and lease ID.

## Temporary coturn REST credentials (remote trial)

The server now supports **new server-only settings** `TURN_SHARED_SECRET` and `TURN_CREDENTIAL_TTL_SECONDS`. These were not part of the former static TURN configuration. Provision them through the server process environment or hosting secret store; never put the shared secret in client/Tauri build settings, invitation links, logs, or committed `.env` files. No real secret, hosting setup, or deployment is included here.

| Setting | Contract |
| --- | --- |
| `STUN_URL` | Optional single `stun:` or `stuns:` URI, with optional port and no query. No credentials. |
| `TURN_URL` | Optional comma-separated TURN URIs; whitespace around each entry is trimmed, empty entries rejected. All endpoints must use the same REST shared secret. |
| `TURN_SHARED_SECRET` | New: shared with coturn's REST authentication configuration (`use-auth-secret` / `static-auth-secret`); minimum 32 UTF-8 bytes, nonblank. Provision a high-entropy secret outside the repository. The server uses its exact UTF-8 bytes, without decoding base64 or trimming. |
| `TURN_CREDENTIAL_TTL_SECONDS` | New: integer seconds, default **3900**, at most **86400**, and at least `ROOM_TTL_SECONDS + 60`. Requires `TURN_URL` and `TURN_SHARED_SECRET`. |
| `ROOM_TTL_SECONDS` | Existing fixed room lifetime, default **3600**. Joins/resumptions do not extend this deadline. With dynamic TURN, rooms longer than 86340 seconds cannot satisfy the credential lifetime bound. |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | Existing legacy static settings remain available outside production only, and require `TURN_URL` together. They cannot be combined with either new dynamic setting, even if an explicitly set value is empty. |

With `NODE_ENV=production`, enabling TURN requires `TURN_SHARED_SECRET`; static TURN environment variables cause startup rejection. STUN-only or no ICE configuration remains valid. Existing production `ALLOWED_ORIGINS` requirements still apply.

Supported TURN URI examples: `turn:relay.example:3478?transport=udp`, `turn:relay.example:3478?transport=tcp`, and `turns:relay.example:5349?transport=tcp`. `turn:` supports UDP or TCP (omitting transport uses the browser's TURN default, normally UDP). `turns:` means TURN over TLS/TCP and permits no transport query or `transport=tcp`; `turns:?transport=udp` (DTLS), `transport=tls`, HTTPS URLs, `//` prefixes, paths, fragments, userinfo, and extra query parameters are rejected. Hosts must be ASCII hostname labels, IPv4, or bracketed IPv6 without zone identifiers; ports, if present, are 1–65535. Actual UDP/TCP/TLS listeners, trusted TLS certificates, relay port reachability, and browser support must be configured and checked on the eventual coturn host. This implementation does not provision them.

### Wire contract and lifetime

- Existing `v: 1` room, signaling, and floor schemas remain unchanged. Successful `created` / own `joined` acknowledgements and the existing unsolicited peer-refresh `joined` acknowledgement contain `iceServers: [{ urls: string, username?: string, credential?: string }]`.
- Every authorized acknowledgement receives a fresh username `<unixExpiry>:<randomNonce>`: expiry is Unix seconds (`floor(Date.now()/1000) + TTL`), nonce is 16 cryptographically random bytes encoded as 32 hex characters. Credential is standard base64 of `HMAC-SHA1(TURN_SHARED_SECRET, username)`, compatible with coturn REST authentication's default colon separator.
- Each configured TURN URL is a separate array entry (preserving the existing string `urls` field), sharing that acknowledgement's temporary username/credential. Different acknowledgements, including peer refreshes, receive different nonces. STUN entries retain their credential-free shape.
- Issuance happens only after successful room admission. Unauthorized, invalid-resume, full-room, stale, or otherwise rejected joins receive no ICE configuration and cause no peer refresh. No public credential endpoint or refresh message is added. The shared secret is only retained in server memory, never placed in a response or logged by this implementation; do not log server configuration objects.
- The default 3900-second credential lifetime covers the entire default 3600-second fixed room lifetime plus margin. Startup enforces at least 60 seconds of margin even for customized lifetimes. Keep signaling/coturn clocks synchronized within this margin. Existing allocations can authenticate for the room's full remaining lifetime without a new credential-refresh protocol. Temporary TURN credentials are bearer credentials until expiry; leaving a room does not individually revoke them.

Validation: run `npm run typecheck`, `npm test`, and `npm run build` from `server/`. These check local configuration and WebSocket issuance, not a live hosted coturn allocation.
