import assert from "node:assert/strict";
import { describe, it, expect } from "vitest";
import { parseMessage } from "../src/protocol.js";

describe("protocol", () => {
it("accepts bounded join and rejects malformed/versioned messages", () => {
  const message = parseMessage(Buffer.from(JSON.stringify({ v: 1, id: "1", type: "join", roomCode: "ABC123", sessionId: "s", generation: 0 })));
  assert.equal(message.type, "join");
  assert.throws(() => parseMessage(JSON.stringify({ v: 1, id: "1", type: "join", roomCode: "ABC123", invitationToken: "legacy", sessionId: "s", generation: 0 })));
  assert.throws(() => parseMessage(Buffer.from(JSON.stringify({ v: 2, id: "1", type: "ping" }))));
  assert.throws(() => parseMessage(Buffer.alloc(65_537)));
});

it("bounds SDP and ICE payloads and rejects extra fields", () => {
  assert.throws(() => parseMessage(Buffer.from(JSON.stringify({ v: 1, id: "1", type: "signal", kind: "ice", payload: "x".repeat(8_193), generation: 0, epoch: 1 }))));
  assert.throws(() => parseMessage(JSON.stringify({ v: 1, id: "1", type: "signal", kind: "offer", payload: "x".repeat(32_769), generation: 0, epoch: 1 })));
  assert.throws(() => parseMessage(JSON.stringify({ v: 1, id: "1", type: "ping", extra: true })));
});

it("parses fragmented binary input without accepting malformed generations", () => {
  const encoded = Buffer.from(JSON.stringify({ v: 1, id: "p", type: "ping" }));
  expect(parseMessage([encoded.subarray(0, 4), encoded.subarray(4)])).toMatchObject({ type: "ping", id: "p" });
  assert.throws(() => parseMessage(JSON.stringify({ v: 1, id: "r", type: "ready", generation: -1 })));
  assert.throws(() => parseMessage(JSON.stringify({ v: 1, id: "r", type: "ready", generation: 1.5 })));
});

it("accepts floor control messages with strict fields", () => {
  expect(parseMessage(JSON.stringify({ v: 1, id: "f", type: "request_floor", generation: 2, epoch: 1 })).type).toBe("request_floor");
  expect(parseMessage(JSON.stringify({ v: 1, id: "r", type: "release_floor", generation: 2, epoch: 1, leaseId: "lease" })).type).toBe("release_floor");
  expect(parseMessage(JSON.stringify({ v: 1, id: "s", type: "speaking", generation: 2, epoch: 1, leaseId: "lease", speaking: true })).type).toBe("speaking");
  assert.throws(() => parseMessage(JSON.stringify({ v: 1, id: "s", type: "speaking", generation: 2, epoch: 1, leaseId: "lease", speaking: true, extra: 1 })));
});

it.each(["request_floor", "release_floor", "speaking"])("requires a positive safe epoch for %s", type => {
  const message = { v: 1, id: "f", type, generation: 2, ...(type !== "request_floor" ? { leaseId: "lease" } : {}), ...(type === "speaking" ? { speaking: true } : {}) };
  for (const epoch of [undefined, null, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseMessage(JSON.stringify({ ...message, epoch }))).toThrow("invalid_message");
  }
});

it("accepts an optional bounded resume token only on join", () => {
  const message = { v: 1, id: "join", type: "join", roomCode: "ABC123", sessionId: "a", generation: 2 };
  expect(parseMessage(JSON.stringify(message))).toEqual(message);
  expect(parseMessage(JSON.stringify({ ...message, resumeToken: "secret" }))).toEqual({ ...message, resumeToken: "secret" });
  for (const resumeToken of [null, false, "", "x".repeat(257)]) expect(() => parseMessage(JSON.stringify({ ...message, resumeToken }))).toThrow("invalid_message");
  expect(() => parseMessage(JSON.stringify({ v: 1, id: "c", type: "create", sessionId: "a", generation: 0, resumeToken: "secret" }))).toThrow("invalid_message");
  for (const roomCode of ["abc123", "ABC12", "ABC1234", "ABC-12", "АBC123"]) expect(() => parseMessage(JSON.stringify({ ...message, roomCode }))).toThrow("invalid_message");
});
});
