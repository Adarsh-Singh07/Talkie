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
