import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import WebSocket from "ws";
import { createHmac } from "node:crypto";
import * as ice from "../src/ice.js";
import { optionsFromEnvironment } from "../src/index.js";
import { canonicalOrigin, createSignalingServer, rateLimitClientIp, type ServerOptions } from "../src/server.js";
import { TestSocket, type Message } from "./websocket-harness.js";

const running: ReturnType<typeof createSignalingServer>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map(server => server.close()));
  vi.restoreAllMocks();
});

async function start(options: ServerOptions = {}) {
  const signaling = createSignalingServer({ heartbeatIntervalMs: 60_000, ...options }); running.push(signaling);
  await signaling.listen(0);
  const address = signaling.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const url = `ws://127.0.0.1:${address.port}`;
  return { signaling, url, port: address.port, connect: () => new TestSocket(url).open() };
}

function joinMessage(created: Message, sessionId: string, generation: number, id = "join", resumeToken?: unknown): Message {
  return { v: 1, id, type: "join", roomCode: created.roomCode, sessionId, generation, ...(resumeToken !== undefined ? { resumeToken } : {}) };
}

async function ready(a: TestSocket, b: TestSocket, generationA = 1, generationB = 7, epoch = 1) {
  a.send({ v: 1, id: `ready-a-${epoch}`, type: "ready", generation: generationA });
  b.send({ v: 1, id: `ready-b-${epoch}`, type: "ready", generation: generationB });
  const [first, second] = await Promise.all([a.next(), b.next()]);
  expect(first).toEqual({ v: 1, type: "peer_ready", generation: generationA, epoch, offerer: true });
  expect(second).toEqual({ v: 1, type: "peer_ready", generation: generationB, epoch, offerer: false });
}

async function pair(options: ServerOptions = {}, makeReady = true) {
  const app = await start(options); const a = await app.connect(); const b = await app.connect();
  a.send({ v: 1, id: "create", type: "create", sessionId: "a", generation: 1 });
  const created = await a.next();
  expect(created).toMatchObject({ type: "created", id: "create", generation: 1, participantCount: 1, resumeToken: expect.any(String) });
  expect(created).not.toHaveProperty("invitationToken");
  b.send(joinMessage(created, "b", 7)); const joined = await b.next();
  expect(joined).toMatchObject({ type: "joined", id: "join", generation: 7, participantCount: 2, resumeToken: expect.any(String) });
  expect(joined.resumeToken).not.toBe(created.resumeToken);
  const notification = await a.next();
  expect(notification).toMatchObject({ type: "joined", generation: 1, participantCount: 2 });
  expect(notification).not.toHaveProperty("resumeToken"); expect(notification).not.toHaveProperty("invitationToken"); expect(notification).not.toHaveProperty("id");
  if (makeReady) await ready(a, b);
  return { ...app, a, b, created, joined };
}

async function grant(a: TestSocket, b: TestSocket, id = "floor", generation = 1, epoch = 1): Promise<Message> {
  a.send({ v: 1, id, type: "request_floor", generation, epoch });
  const floor = await a.next(); const peerFloor = await b.next();
  expect(floor).toMatchObject({ v: 1, type: "floor_granted", id, generation, epoch, leaseId: expect.any(String), expiresAt: expect.any(Number), leaseDurationMs: expect.any(Number) });
  expect(peerFloor).toEqual({ ...floor, generation: 7 });
  return floor;
}

/** A pong is a FIFO barrier; unexpected notifications fail instead of being filtered out. */
async function barrier(socket: TestSocket, id: string) {
  socket.send({ v: 1, id, type: "ping" });
  expect(await socket.next()).toEqual({ v: 1, id, type: "pong" });
}

describe("signaling server", () => {
  it("canonicalizes http, https, and tauri localhost origins and trusts a single Cloudflare IP only behind loopback", () => {
    expect(canonicalOrigin("http://localhost:80/")).toBe("http://localhost");
    expect(canonicalOrigin("https://localhost:443")).toBe("https://localhost");
    expect(canonicalOrigin("tauri://localhost/")).toBe("tauri://localhost");
    const request = (remoteAddress: string, header?: string | string[]) => ({ socket: { remoteAddress }, headers: { "cf-connecting-ip": header } }) as unknown as http.IncomingMessage;
    expect(rateLimitClientIp(request("127.0.0.1", "203.0.113.4"))).toBe("203.0.113.4");
    expect(rateLimitClientIp(request("::ffff:127.0.0.1", "2001:db8::4"))).toBe("2001:db8::4");
    expect(rateLimitClientIp(request("127.0.0.1", "203.0.113.4, 203.0.113.5"))).toBe("127.0.0.1");
    expect(rateLimitClientIp(request("203.0.113.10", "198.51.100.5"))).toBe("203.0.113.10");
  });

  it("uses Cloudflare ICE entries after async admission and falls back without exposing API secrets", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const apiToken = "cloudflare-api-token";
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    const app = await start({ cloudflareTurn: { keyId: "key-id", apiToken, fetch: fetchImpl } });
    const socket = await app.connect();
    socket.send({ v: 1, id: "create", type: "create", sessionId: "cf-a", generation: 1 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    resolveFetch!(new Response(JSON.stringify({ iceServers: [{ urls: ["turn:turn.cloudflare.com:53?transport=tcp", "turn:turn.cloudflare.com:3478?transport=udp"], username: "cf-user", credential: "cf-secret" }] }), { status: 200 }));
    const created = await socket.next();
    expect(created.iceServers).toEqual([
      { urls: "turn:turn.cloudflare.com:3478?transport=udp", username: "cf-user", credential: "cf-secret" },
      { urls: "turn:turn.cloudflare.com:3478?transport=tcp", username: "cf-user", credential: "cf-secret" },
      { urls: "turns:turn.cloudflare.com:5349?transport=tcp", username: "cf-user", credential: "cf-secret" },
    ]);
    expect(JSON.stringify(created)).not.toContain(apiToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to configured coturn or STUN when Cloudflare credential generation fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream unavailable", { status: 503 }));
    const app = await start({
      cloudflareTurn: { keyId: "key-id", apiToken: "api-token", fetch: fetchImpl },
      iceServers: [{ urls: "stun:fallback.example:3478" }],
    });
    const socket = await app.connect();
    socket.send({ v: 1, id: "create", type: "create", sessionId: "fallback", generation: 1 });
    expect(await socket.next()).toMatchObject({ type: "created", iceServers: [{ urls: "stun:fallback.example:3478" }] });
  });

  it("does not send an asynchronous admission acknowledgement after disconnect", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve; }));
    const app = await start({ cloudflareTurn: { keyId: "key-id", apiToken: "api-token", fetch: fetchImpl } });
    const socket = await app.connect();
    socket.send({ v: 1, id: "create", type: "create", sessionId: "departed", generation: 1 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    socket.close(); await socket.closed;
    resolveFetch!(new Response(JSON.stringify({ iceServers: [{ urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" }] }), { status: 200 }));
    await vi.waitFor(() => expect(app.signaling.manager.size()).toBe(1));
  });

  it("issues unique coturn REST credentials only for successful room acknowledgements", async () => {
    const secret = "test-only-placeholder-not-a-real-secret";
    const now = 1_800_000_000_123;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const issuance = vi.spyOn(ice, "issueIceServers");
    const options = optionsFromEnvironment({
      NODE_ENV: "production", ALLOWED_ORIGINS: "https://talkie.example",
      STUN_URL: "stun:relay.example:3478",
      TURN_URL: "turn:relay.example:3478?transport=udp,turns:relay.example:5349?transport=tcp",
      TURN_SHARED_SECRET: secret,
    });
    const app = await start({ ...options, allowedOrigins: [] });
    const a = await app.connect(); const b = await app.connect(); const attacker = await app.connect();
    a.send({ v: 1, id: "create", type: "create", sessionId: "a", generation: 1 });
    const created = await a.next();
    expect(issuance).toHaveBeenCalledTimes(1);
    for (const [id, overrides] of [
      ["missing-room", { roomCode: "ZZZZZZ" }],
      ["stolen-identity", { sessionId: "a" }],
    ] as const) {
      attacker.send({ ...joinMessage(created, "attacker", 99, id), ...overrides });
      const error = await attacker.next();
      expect(error.type).toBe("error");
      expect(error).not.toHaveProperty("iceServers");
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(issuance).toHaveBeenCalledTimes(1);
    await barrier(a, "no-peer-refresh-after-rejection");
    b.send(joinMessage(created, "b", 7));
    const joined = await b.next(); const peerRefresh = await a.next();
    expect(issuance).toHaveBeenCalledTimes(3);
    expect(peerRefresh).toMatchObject({ type: "joined", generation: 1 });
    expect(peerRefresh).not.toHaveProperty("id");
    const usernames: string[] = [];
    for (const message of [created, joined, peerRefresh]) {
      const servers = message.iceServers as ice.IceServer[];
      expect(servers).toHaveLength(3);
      expect(servers[0]).toEqual({ urls: "stun:relay.example:3478" });
      const username = servers[1].username!;
      expect(username).toMatch(/^1800003900:[0-9a-f]{32}$/);
      expect(Number(username.split(":")[0])).toBe(Math.floor(now / 1000) + 3900);
      const credential = createHmac("sha1", secret).update(username, "utf8").digest("base64");
      expect(servers[1]).toEqual({ urls: "turn:relay.example:3478?transport=udp", username, credential });
      expect(servers[2]).toEqual({ urls: "turns:relay.example:5349?transport=tcp", username, credential });
      expect(JSON.stringify(message)).not.toContain(secret);
      expect(JSON.stringify(message)).not.toContain("sharedSecret");
      usernames.push(username);
    }
    expect(new Set(usernames).size).toBe(3);
    attacker.send(joinMessage(created, "third", 0, "room-full"));
    expect(await attacker.next()).toMatchObject({ type: "error", code: "room_full" });
    expect(issuance).toHaveBeenCalledTimes(3);
    await barrier(a, "still-no-ice"); await barrier(b, "peer-no-ice");
    expect(issuance).toHaveBeenCalledTimes(3);
  });

  it("validates direct server TURN options before accepting connections", () => {
    const turnRest = { urls: ["turn:relay.example"], sharedSecret: "test-only-placeholder-not-a-real-secret", ttlSeconds: 3900 };
    expect(() => createSignalingServer({ turnRest: { ...turnRest, ttlSeconds: 3659 } })).toThrow(/TTL/);
    expect(() => createSignalingServer({ turnRest: { ...turnRest, sharedSecret: "short" } })).toThrow(/SECRET/);
    expect(() => createSignalingServer({ turnRest, iceServers: [{ urls: "turn:legacy.example", username: "user", credential: "pass" }] })).toThrow(/mixed/);
  });

  it("echoes the requesting generation for rejected pre-join credentials", async () => {
    const app = await start(); const socket = await app.connect();
    socket.send({ v: 1, id: "bad-join", type: "join", roomCode: "ABC123", sessionId: "new", generation: 9 });
    expect(await socket.next()).toMatchObject({ v: 1, id: "bad-join", type: "error", generation: 9, code: "unauthorized_room" });
  });
  it("creates, joins, and relays signaling with each recipient's independent generation", async () => {
    const { a, b } = await pair({}, false);
    a.send({ v: 1, id: "stale-ready", type: "ready", generation: 7 });
    expect(await a.next()).toMatchObject({ type: "error", id: "stale-ready", code: "stale_generation", generation: 7 });
    await ready(a, b);
    a.send({ v: 1, id: "stale-epoch", type: "signal", kind: "offer", payload: "old", generation: 1, epoch: 2 });
    expect(await a.next()).toMatchObject({ type: "error", code: "stale_epoch" });
    a.send({ v: 1, id: "signal", type: "signal", kind: "offer", payload: "sdp", generation: 1, epoch: 1 });
    expect(await b.next()).toEqual({ v: 1, id: "signal", type: "signal", payload: "sdp", kind: "offer", generation: 7, epoch: 1 });
    b.send({ v: 1, id: "answer", type: "signal", kind: "answer", payload: "answer", generation: 7, epoch: 1 });
    expect(await a.next()).toMatchObject({ type: "signal", kind: "answer", generation: 1, epoch: 1 });
  });

  it("serializes PTT, preserves exact grant IDs/duration, relays speaking, and rejects replay", async () => {
    const { a, b } = await pair(); const floor = await grant(a, b, "exact-floor-request");
    expect(floor.leaseDurationMs).toBe(30_000);
    b.send({ v: 1, id: "busy", type: "request_floor", generation: 7, epoch: 1 });
    expect(await b.next()).toMatchObject({ type: "error", code: "floor_busy" });
    a.send({ v: 1, id: "exact-floor-request", type: "request_floor", generation: 1, epoch: 1 });
    expect(await a.next()).toMatchObject({ type: "error", code: "replayed_message" });
    for (const speaking of [true, false]) {
      a.send({ v: 1, id: `speak-${speaking}`, type: "speaking", generation: 1, epoch: 1, leaseId: floor.leaseId, speaking });
      expect(await a.next()).toMatchObject({ type: "speaking", epoch: 1, leaseId: floor.leaseId, speaking, generation: 1 });
      expect(await b.next()).toMatchObject({ type: "speaking", epoch: 1, leaseId: floor.leaseId, speaking, generation: 7 });
    }
    a.send({ v: 1, id: "release", type: "release_floor", generation: 1, epoch: 1, leaseId: floor.leaseId });
    expect(await a.next()).toMatchObject({ type: "floor_released", id: "release", epoch: 1, leaseId: floor.leaseId });
    expect(await b.next()).toMatchObject({ type: "floor_released", id: "release", epoch: 1, leaseId: floor.leaseId });
    a.send({ v: 1, id: "release-again", type: "release_floor", generation: 1, epoch: 1, leaseId: floor.leaseId });
    await barrier(a, "after-repeat"); await barrier(b, "after-repeat-peer");
  });

  it("rejects floor acquisition before two current peers are ready", async () => {
    const { a, b, signaling, created } = await pair({}, false);
    a.send({ v: 1, id: "early", type: "request_floor", generation: 1, epoch: 1 });
    expect(await a.next()).toMatchObject({ type: "error", code: "stale_epoch" });
    a.send({ v: 1, id: "ready-alone", type: "ready", generation: 1 });
    a.send({ v: 1, id: "still-early", type: "request_floor", generation: 1, epoch: 1 });
    expect(await a.next()).toMatchObject({ type: "error", code: "stale_epoch" });
    expect(signaling.manager.get(String(created.roomCode))?.floor).toBeUndefined();
    await ready(a, b); await grant(a, b);
  });

  it("rejects malicious speaking and ignores foreign or wrong release leases", async () => {
    const { a, b, signaling, created } = await pair(); const floor = await grant(a, b);
    b.send({ v: 1, id: "steal-speaking", type: "speaking", generation: 7, epoch: 1, leaseId: floor.leaseId, speaking: true });
    expect(await b.next()).toMatchObject({ type: "error", code: "invalid_floor_lease" });
    a.send({ v: 1, id: "wrong-speaking", type: "speaking", generation: 1, epoch: 1, leaseId: "wrong", speaking: true });
    expect(await a.next()).toMatchObject({ type: "error", code: "invalid_floor_lease" });
    b.send({ v: 1, id: "steal-release", type: "release_floor", generation: 7, epoch: 1, leaseId: floor.leaseId });
    a.send({ v: 1, id: "wrong-release", type: "release_floor", generation: 1, epoch: 1, leaseId: "wrong" });
    await barrier(a, "owner-barrier"); await barrier(b, "peer-barrier");
    expect(signaling.manager.get(String(created.roomCode))?.floor).toMatchObject({ leaseId: floor.leaseId, speaking: false, epoch: 1 });
    for (const message of [
      { type: "request_floor" },
      { type: "release_floor", leaseId: floor.leaseId },
      { type: "speaking", leaseId: floor.leaseId, speaking: true },
    ]) {
      a.send({ v: 1, id: `missing-${message.type}`, generation: 1, ...message });
      expect(await a.next()).toMatchObject({ type: "error", code: "invalid_message" });
      a.send({ v: 1, id: `stale-${message.type}`, generation: 1, epoch: 2, ...message });
      expect(await a.next()).toMatchObject({ type: "error", code: "stale_epoch" });
    }
    expect(signaling.manager.get(String(created.roomCode))?.floor?.leaseId).toBe(floor.leaseId);
  });

  it.each(["a", "b"])("clears capacity and releases the exact epoch lease when %s disconnects", async sessionId => {
    const { a, b, created, connect } = await pair(); const floor = await grant(a, b);
    const departing = sessionId === "a" ? a : b; const remaining = sessionId === "a" ? b : a;
    departing.close(); await departing.closed;
    expect(await remaining.next()).toMatchObject({ type: "floor_released", sessionId: "a", epoch: 1, leaseId: floor.leaseId });
    expect(await remaining.next()).toMatchObject({ type: "peer_left", sessionId });
    const c = await connect(); c.send(joinMessage(created, "c", 0, "join-c"));
    expect(await c.next()).toMatchObject({ type: "joined", participantCount: 2, resumeToken: expect.any(String) });
    expect(await remaining.next()).toMatchObject({ type: "joined", participantCount: 2 });
  });

  it("rejects missing and incorrect live resume proof without touching a victim's floor", async () => {
    const { a, b, created, joined, connect, signaling } = await pair(); const floor = await grant(a, b);
    const attacker = await connect();
    for (const [index, proof] of [undefined, "wrong", joined.resumeToken].entries()) {
      attacker.send(joinMessage(created, "a", 99, `hijack-${index}`, proof));
      expect(await attacker.next()).toMatchObject({ type: "error", id: `hijack-${index}`, code: "invalid_resume_token" });
      expect(signaling.manager.get(String(created.roomCode))?.floor?.leaseId).toBe(floor.leaseId);
    }
    await barrier(a, "victim-alive"); await barrier(b, "peer-unchanged");
    expect(a.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("securely replaces a live peer, preserves joined notifications, and renegotiates independent generations", async () => {
    const { a, b, created, connect } = await pair(); const floor = await grant(a, b); const newA = await connect();
    newA.send(joinMessage(created, "a", 2, "resume-a", created.resumeToken));
    expect(await newA.next()).toMatchObject({ type: "joined", id: "resume-a", generation: 2, resumeToken: created.resumeToken });
    expect(await a.closed).toEqual({ code: 1000, reason: "session_replaced" });
    const [left, joined, release] = await b.nextMany(3);
    expect(left).toMatchObject({ type: "peer_left", sessionId: "a", generation: 7 });
    expect(joined).toMatchObject({ type: "joined", generation: 7 }); expect(joined).not.toHaveProperty("resumeToken");
    expect(release).toMatchObject({ type: "floor_released", epoch: 1, leaseId: floor.leaseId, generation: 7 });
    expect(await newA.next()).toMatchObject({ type: "floor_released", epoch: 1, leaseId: floor.leaseId, generation: 2 });
    await ready(newA, b, 2, 7, 2);
    const current = await grant(newA, b, "new-floor", 2, 2);
    for (const message of [
      { type: "request_floor" },
      { type: "release_floor", leaseId: current.leaseId },
      { type: "speaking", leaseId: current.leaseId, speaking: true },
    ]) {
      b.send({ v: 1, id: `old-${message.type}`, generation: 7, epoch: 1, ...message });
      expect(await b.next()).toMatchObject({ type: "error", code: "stale_epoch" });
    }
    await barrier(newA, "new-floor-unaffected");
  });

  it("protects disconnected identity tombstones and allows valid resumes", async () => {
    const { a, b, created, connect } = await pair(); a.close(); await a.closed;
    expect(await b.next()).toMatchObject({ type: "peer_left", sessionId: "a" });
    const replacement = await connect();
    for (const [index, proof] of [undefined, "wrong"].entries()) {
      replacement.send(joinMessage(created, "a", 2, `bad-${index}`, proof));
      expect(await replacement.next()).toMatchObject({ type: "error", code: "invalid_resume_token" });
    }
    replacement.send(joinMessage(created, "a", 1, "stale-resume", created.resumeToken));
    expect(await replacement.next()).toMatchObject({ type: "error", code: "stale_generation" });
    replacement.send(joinMessage(created, "a", 2, "valid-resume", created.resumeToken));
    expect(await replacement.next()).toMatchObject({ type: "joined", id: "valid-resume", resumeToken: created.resumeToken });
    expect(await b.next()).toMatchObject({ type: "joined", generation: 7 });
  });

  it("recovers both-drop staggered rejoins without waiting for coincident readiness", async () => {
    const { a, b, created, joined, connect, signaling } = await pair(); a.close(); b.close();
    await Promise.all([a.closed, b.closed]);
    await vi.waitFor(() => expect(signaling.manager.get(String(created.roomCode))?.participants.size).toBe(0));
    const newA = await connect(); newA.send(joinMessage(created, "a", 3, "resume-a", created.resumeToken));
    expect(await newA.next()).toMatchObject({ type: "joined", participantCount: 1, generation: 3 });
    newA.send({ v: 1, id: "ready-alone", type: "ready", generation: 3 }); await barrier(newA, "ready-processed");
    const newB = await connect(); newB.send(joinMessage(created, "b", 8, "resume-b", joined.resumeToken));
    expect(await newB.next()).toMatchObject({ type: "joined", participantCount: 2, generation: 8 });
    const peerJoined = await newA.next(); expect(peerJoined).toMatchObject({ type: "joined", generation: 3 }); expect(peerJoined).not.toHaveProperty("resumeToken");
    newB.send({ v: 1, id: "ready-b", type: "ready", generation: 8 });
    expect(await newA.next()).toMatchObject({ type: "peer_ready", epoch: 2, generation: 3, offerer: true });
    expect(await newB.next()).toMatchObject({ type: "peer_ready", epoch: 2, generation: 8, offerer: false });
    newA.send({ v: 1, id: "resumed-floor", type: "request_floor", generation: 3, epoch: 2 });
    expect(await newA.next()).toMatchObject({ type: "floor_granted", epoch: 2, generation: 3 });
    expect(await newB.next()).toMatchObject({ type: "floor_granted", epoch: 2, generation: 8 });
  });

  it("reports lazy lease expiry before a new grant and does not mutate on stale requests", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { a, b, created, signaling } = await pair({ floorLeaseMs: 10_000 }); const floor = await grant(a, b);
    clock.mockReturnValue(11_000);
    a.send({ v: 1, id: "old-epoch", type: "request_floor", generation: 1, epoch: 2 });
    expect(await a.next()).toMatchObject({ type: "error", code: "stale_epoch" });
    expect(signaling.manager.get(String(created.roomCode))?.floor?.leaseId).toBe(floor.leaseId);
    b.send({ v: 1, id: "floor-b", type: "request_floor", generation: 7, epoch: 1 });
    for (const socket of [a, b]) {
      expect(await socket.next()).toMatchObject({ type: "floor_expired", epoch: 1, leaseId: floor.leaseId });
      expect(await socket.next()).toMatchObject({ type: "floor_granted", id: "floor-b", epoch: 1, sessionId: "b", expiresAt: 21_000, leaseDurationMs: 10_000 });
    }
  });

  it("does not emit a late old lease expiry into a replacement epoch", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { a, b, created, connect } = await pair({ floorLeaseMs: 10_000 }); const oldFloor = await grant(a, b);
    const newA = await connect(); newA.send(joinMessage(created, "a", 2, "resume", created.resumeToken));
    expect(await newA.next()).toMatchObject({ type: "joined" });
    expect(await newA.next()).toMatchObject({ type: "floor_released", epoch: 1, leaseId: oldFloor.leaseId });
    const peerEvents = await b.nextMany(3); expect(peerEvents.map(event => event.type)).toEqual(["peer_left", "joined", "floor_released"]);
    await ready(newA, b, 2, 7, 2);
    clock.mockReturnValue(6000); const current = await grant(newA, b, "floor-new", 2, 2);
    clock.mockReturnValue(11_000);
    newA.send({ v: 1, id: "still-speaking", type: "speaking", generation: 2, epoch: 2, leaseId: current.leaseId, speaking: true });
    expect(await newA.next()).toMatchObject({ type: "speaking", epoch: 2, leaseId: current.leaseId });
    expect(await b.next()).toMatchObject({ type: "speaking", epoch: 2, leaseId: current.leaseId });
    await barrier(newA, "no-late-expiry"); await barrier(b, "no-late-expiry-peer");
  });

  it("timer-expires a lease without client traffic", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { a, b } = await pair({ floorLeaseMs: 25 }); const floor = await grant(a, b);
    clock.mockReturnValue(1025);
    expect(await a.next()).toMatchObject({ type: "floor_expired", epoch: 1, leaseId: floor.leaseId, generation: 1 });
    expect(await b.next()).toMatchObject({ type: "floor_expired", epoch: 1, leaseId: floor.leaseId, generation: 7 });
    a.send({ v: 1, id: "expired-speaking", type: "speaking", generation: 1, epoch: 1, leaseId: floor.leaseId, speaking: true });
    expect(await a.next()).toMatchObject({ type: "error", code: "floor_expired" });
  });

  it("proactively errors and closes both room sockets at TTL without any client message", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { a, b, signaling } = await pair({ roomTtlMs: 25 }); await grant(a, b);
    clock.mockReturnValue(1025);
    expect(await a.next()).toEqual({ v: 1, type: "error", code: "room_expired", generation: 1 });
    expect(await b.next()).toEqual({ v: 1, type: "error", code: "room_expired", generation: 7 });
    expect(await a.closed).toEqual({ code: 1000, reason: "room_expired" });
    expect(await b.closed).toEqual({ code: 1000, reason: "room_expired" });
    expect(signaling.manager.size()).toBe(0);
  });

  it("keeps malformed traffic isolated, queues bursts, and exposes health", async () => {
    const { connect, port } = await start();
    const health = await new Promise<{ statusCode?: number; body: string }>((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/health" }, response => {
        let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);
        response.on("end", () => resolve({ statusCode: response.statusCode, body }));
      }); request.on("error", reject);
    });
    expect(health).toEqual({ statusCode: 200, body: JSON.stringify({ status: "ok" }) });
    const socket = await connect(); socket.socket.send("not-json");
    expect(await socket.next()).toMatchObject({ type: "error", code: "invalid_json" });
    for (let i = 0; i < 5; i++) socket.send({ v: 1, id: `ping-${i}`, type: "ping" });
    for (let i = 0; i < 5; i++) expect(await socket.next()).toEqual({ v: 1, id: `ping-${i}`, type: "pong" });
  });

  it("enforces missing/denied origins, canonical allowed origin, socket and message budgets", async () => {
    const { url } = await start({ allowedOrigins: ["https://allowed.example:443"], maxSockets: 1, maxMessagesPerWindow: 1 });
    for (const origin of [undefined, "https://denied.example"]) expect((await new TestSocket(url, { origin }).closed).code).toBe(1006);
    const first = await new TestSocket(url, { origin: "https://allowed.example" }).open();
    expect((await new TestSocket(url, { origin: "https://allowed.example" }).closed).code).toBe(1006);
    await barrier(first, "ping"); first.send({ v: 1, id: "ping-2", type: "ping" });
    expect(await first.closed).toEqual({ code: 1008, reason: "rate_limited" });
    const replacement = await new TestSocket(url, { origin: "https://allowed.example" }).open(); await barrier(replacement, "capacity-reclaimed");
  });

  it("counts sockets awaiting their close handshake against the socket budget", async () => {
    const { signaling, url, connect } = await start({ maxSockets: 1, maxMessagesPerWindow: 1 }); const first = await connect();
    await barrier(first, "ping"); first.socket.pause(); first.send({ v: 1, id: "rate-limit", type: "ping" });
    await vi.waitFor(() => expect([...signaling.wss.clients][0]?.readyState).toBe(WebSocket.CLOSING));
    expect((await new TestSocket(url).closed).code).toBe(1006);
    first.socket.resume(); expect((await first.closed).code).toBe(1008);
    const next = await connect(); await barrier(next, "next-socket");
  });

  it("enforces per-IP upgrade budgets and resets them at the window boundary", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { url, connect } = await start({ maxUpgradesPerWindow: 1, rateLimitWindowMs: 100 }); const first = await connect();
    first.close(); await first.closed; expect((await new TestSocket(url).closed).code).toBe(1006);
    clock.mockReturnValue(1100); const next = await connect(); await barrier(next, "new-window");
  });

  it("shuts down promptly with a detached socket still awaiting its close handshake", async () => {
    const { signaling, connect } = await start({ maxMessagesPerWindow: 0 }); const socket = await connect();
    socket.socket.pause(); socket.send({ v: 1, id: "denied", type: "ping" });
    await vi.waitFor(() => expect([...signaling.wss.clients][0]?.readyState).toBe(WebSocket.CLOSING));
    await signaling.close();
    socket.socket.resume(); await socket.closed;
    expect(signaling.wss.clients.size).toBe(0);
  });

  it("enforces per-IP create/join budgets independently", async () => {
    const { connect } = await start({ maxCreatesPerWindow: 1, maxJoinsPerWindow: 1 }); const a = await connect(); const b = await connect(); const c = await connect();
    a.send({ v: 1, id: "create", type: "create", sessionId: "a", generation: 0 }); const created = await a.next();
    b.send({ v: 1, id: "create-denied", type: "create", sessionId: "b", generation: 0 });
    expect(await b.next()).toMatchObject({ type: "error", code: "rate_limited" });
    b.send(joinMessage(created, "b", 0)); expect(await b.next()).toMatchObject({ type: "joined" });
    c.send(joinMessage(created, "c", 0)); expect(await c.next()).toMatchObject({ type: "error", code: "rate_limited" });
  });

  it("enforces room and IP entry budgets", async () => {
    const rooms = await start({ maxRooms: 0 }); const socket = await rooms.connect();
    socket.send({ v: 1, id: "create", type: "create", sessionId: "a", generation: 0 });
    expect(await socket.next()).toMatchObject({ type: "error", code: "room_capacity" });
    const ips = await start({ maxIpEntries: 0 }); expect((await new TestSocket(ips.url).closed).code).toBe(1006);
  });

  it.each(["binary", "oversize"])("closes %s traffic and releases the departing peer's floor", async kind => {
    const { a, b } = await pair({ maxMessageBytes: 512 }); const floor = await grant(a, b);
    a.socket.send(kind === "binary" ? Buffer.from("binary") : "x".repeat(513));
    expect((await a.closed).code).toBe(kind === "binary" ? 1003 : 1009);
    expect(await b.next()).toMatchObject({ type: "floor_released", epoch: 1, leaseId: floor.leaseId });
    expect(await b.next()).toMatchObject({ type: "peer_left", sessionId: "a" });
  });

  it("terminates a missed heartbeat and reclaims socket capacity", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { url, connect } = await start({ heartbeatIntervalMs: 10, heartbeatTimeoutMs: 25, maxSockets: 1 });
    const socket = await new TestSocket(url, { autoPong: false }).open(); now.mockReturnValue(1026);
    expect((await socket.closed).code).toBe(1006);
    const replacement = await connect(); await barrier(replacement, "heartbeat-reclaimed");
  });

  it("rejects unsafe direct resource settings instead of disabling limits", () => {
    expect(() => createSignalingServer({ maxMessagesPerWindow: Number.NaN })).toThrow(/maxMessagesPerWindow/);
    expect(() => createSignalingServer({ maxMessageBytes: Number.POSITIVE_INFINITY })).toThrow(/maxMessageBytes/);
    expect(() => createSignalingServer({ heartbeatIntervalMs: 10, heartbeatTimeoutMs: 10 })).toThrow(/heartbeatTimeoutMs/);
  });

  it("can be closed idempotently before listening", async () => {
    const signaling = createSignalingServer(); await signaling.close(); await signaling.close();
  });
});
