import { describe, it, expect, vi } from "vitest";
import { RoomManager, type Participant } from "../src/room-manager.js";
import { tokensMatch } from "../src/security.js";

function participant(sessionId: string, generation = 1): Participant {
  return { sessionId, generation, send: vi.fn(), close: vi.fn() };
}

function pair(manager = new RoomManager()) {
  const created = manager.create();
  const a = participant("a"); const b = participant("b", 7);
  const joinedA = manager.join(created.room.code, a);
  const joinedB = manager.join(created.room.code, b);
  manager.ready(created.room, a); manager.ready(created.room, b);
  return { manager, ...created, a, b, resumeA: joinedA.resumeToken, resumeB: joinedB.resumeToken };
}

describe("room manager", () => {
  it("generates six-character codes without ambiguous characters", () => {
    const manager = new RoomManager();
    const { room } = manager.create();
    expect(room.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("bounds identity churn while still permitting authenticated resumes", () => {
    const manager = new RoomManager(); const { room } = manager.create();
    let proof = '';
    for (let i = 0; i < 128; i++) {
      const peer = participant(`peer-${i}`);
      const joined = manager.join(room.code, peer);
      if (i === 0) proof = joined.resumeToken;
      manager.remove(room.code, peer.sessionId, peer);
    }
    expect(() => manager.join(room.code, participant('overflow'))).toThrow('room_identity_limit');
    expect(manager.join(room.code, participant('peer-0', 2), proof).room).toBe(room);
  });
  it("authorizes by room code and enforces two participants", () => {
    const { manager, room } = pair();
    expect(() => manager.join(room.code, participant("c"))).toThrow("room_full");
    expect(() => manager.join("WRONG", participant("c"))).toThrow("unauthorized_room");
  });

  it("retains an empty room and its identity tombstones until expiry", () => {
    let now = 0; const { manager, room, a, b } = pair(new RoomManager(10, () => now));
    manager.remove(room.code, "a", a); manager.remove(room.code, "b", b);
    expect(manager.size()).toBe(1); expect(room.identities.size).toBe(2);
    now = 10; expect(manager.get(room.code)).toBeUndefined(); expect(manager.size()).toBe(0);
    expect(room.identities.size).toBe(0);
  });

  it("requires two ready current peers before granting the floor", () => {
    const manager = new RoomManager(); const { room } = manager.create();
    const a = participant("a"); const b = participant("b");
    manager.join(room.code, a);
    expect(() => manager.requestFloor(room, "a", 1, 1)).toThrow("stale_epoch");
    manager.ready(room, a); manager.join(room.code, b);
    expect(() => manager.requestFloor(room, "a", 1, 1)).toThrow("stale_epoch");
    manager.ready(room, b);
    expect(manager.requestFloor(room, "a", 1, 1)).toMatchObject({ epoch: 1, leaseDurationMs: 30_000 });
  });

  it("grants one expiring floor and makes wrong-lease release idempotent", () => {
    let now = 0; const { manager, room } = pair(new RoomManager(1000, () => now, 10));
    const floor = manager.requestFloor(room, "a", 1, 1);
    expect(() => manager.requestFloor(room, "b", 7, 1)).toThrow("floor_busy");
    expect(manager.releaseFloor(room, "a", 1, 1, "wrong")).toBeUndefined();
    expect(manager.releaseFloor(room, "b", 7, 1, floor.leaseId)).toBeUndefined();
    expect(room.floor).toBe(floor);
    expect(() => manager.releaseFloor(room, "a", 0, 1, floor.leaseId)).toThrow("stale_generation");
    now = 10; expect(manager.expireFloors()).toEqual([{ room, floor }]);
    expect(manager.releaseFloor(room, "a", 1, 1, floor.leaseId)).toBeUndefined();
  });

  it.each(["request", "release", "speaking"])("rejects stale epochs before %s can expire or mutate a floor", operation => {
    let now = 0; const { manager, room } = pair(new RoomManager(1000, () => now, 10));
    const floor = manager.requestFloor(room, "a", 1, 1); now = 10;
    expect(() => {
      if (operation === "request") manager.requestFloor(room, "a", 1, 2);
      else if (operation === "release") manager.releaseFloor(room, "a", 1, 2, floor.leaseId);
      else manager.setSpeaking(room, "a", 1, 2, floor.leaseId, true);
    }).toThrow("stale_epoch");
    expect(room.floor).toBe(floor); expect(floor.speaking).toBe(false);
  });

  it("rejects foreign and incorrect speaking leases without altering the holder", () => {
    const { manager, room } = pair(); const floor = manager.requestFloor(room, "a", 1, 1);
    expect(() => manager.setSpeaking(room, "b", 7, 1, floor.leaseId, true)).toThrow("invalid_floor_lease");
    expect(() => manager.setSpeaking(room, "a", 1, 1, "wrong", true)).toThrow("invalid_floor_lease");
    expect(floor.speaking).toBe(false);
    expect(manager.setSpeaking(room, "a", 1, 1, floor.leaseId, true).speaking).toBe(true);
  });

  it("requires private resume proof even when an attacker knows the room code and session ID", () => {
    const { manager, room, a, resumeA, resumeB } = pair();
    const floor = manager.requestFloor(room, "a", 1, 1);
    const replacement = participant("a", 999);
    for (const proof of [undefined, "wrong", resumeB]) {
      expect(() => manager.join(room.code, replacement, proof)).toThrow("invalid_resume_token");
      expect(room.participants.get("a")).toBe(a); expect(room.floor).toBe(floor); expect(room.negotiating).toBe(true);
    }
    expect(a.close).not.toHaveBeenCalled();
    expect(room.identities.get("a")?.resumeHash).not.toBe(resumeA);
    expect(tokensMatch(resumeA, room.identities.get("a")!.resumeHash)).toBe(true);
  });

  it("does not let an old connection remove a securely authorized replacement", () => {
    const { manager, room, a, resumeA } = pair();
    const floor = manager.requestFloor(room, "a", 1, 1); const replacement = participant("a", 2);
    expect(manager.join(room.code, replacement, resumeA)).toMatchObject({ room, resumeToken: resumeA, replacedFloor: floor });
    expect(a.close).toHaveBeenCalledWith("session_replaced");
    expect(manager.remove(room.code, "a", a)).toBeUndefined();
    expect(room.participants.get("a")).toBe(replacement); expect(room.floor).toBeUndefined();
    expect(() => manager.releaseFloor(room, "a", 1, 1, floor.leaseId)).toThrow("stale_generation");
  });

  it.each(["a", "b"])("clears the floor when %s disconnects and allows a fresh identity into its free slot", sessionId => {
    const { manager, room } = pair(); const floor = manager.requestFloor(room, "a", 1, 1);
    expect(manager.remove(room.code, sessionId)?.floor).toBe(floor);
    expect(room.floor).toBeUndefined(); expect(room.negotiating).toBe(false);
    expect(manager.join(room.code, participant("c", 0)).room.participants.size).toBe(2);
  });

  it("requires proof and increasing generations for disconnected tombstones", () => {
    const { manager, room, a, resumeA } = pair(); manager.remove(room.code, "a", a);
    expect(() => manager.join(room.code, participant("a", 2))).toThrow("invalid_resume_token");
    expect(() => manager.join(room.code, participant("a", 2), "wrong")).toThrow("invalid_resume_token");
    expect(() => manager.join(room.code, participant("a", 1), resumeA)).toThrow("stale_generation");
    expect(() => manager.join(room.code, participant("c", 1), resumeA)).toThrow("invalid_resume_token");
    expect(manager.join(room.code, participant("a", 2), resumeA).resumeToken).toBe(resumeA);
  });

  it("expires a floor exactly once at its lease deadline", () => {
    let now = 10; const { manager, room } = pair(new RoomManager(1000, () => now, 5));
    const floor = manager.requestFloor(room, "a", 1, 1); now = floor.expiresAt;
    expect(manager.expireFloor(room)).toBe(floor); expect(manager.expireFloor(room)).toBeUndefined();
  });

  it("starts a new epoch with independent generations and does not expire an invalidated old lease", () => {
    let now = 0; const { manager, room, a, b, resumeA } = pair(new RoomManager(1000, () => now, 10));
    manager.requestFloor(room, "a", 1, 1);
    const replacement = participant("a", 2); manager.join(room.code, replacement, resumeA);
    expect(room.negotiating).toBe(false); expect(() => manager.ready(room, a)).toThrow("stale_generation");
    manager.ready(room, replacement); manager.ready(room, b); expect(room.epoch).toBe(2);
    now = 5; const current = manager.requestFloor(room, "b", 7, 2);
    now = 10; expect(manager.expireFloors()).toEqual([]); expect(room.floor).toBe(current);
    expect(b.send).toHaveBeenLastCalledWith({ v: 1, type: "peer_ready", generation: 7, epoch: 2, offerer: false });
  });

  it("preserves the first peer's readiness through a staggered both-drop rejoin", () => {
    const { manager, room, a, b, resumeA, resumeB } = pair();
    manager.remove(room.code, "a", a); manager.remove(room.code, "b", b);
    const newA = participant("a", 3); const newB = participant("b", 8);
    manager.join(room.code, newA, resumeA); manager.ready(room, newA);
    expect(room.negotiating).toBe(false);
    manager.join(room.code, newB, resumeB); manager.ready(room, newB);
    expect(room.epoch).toBe(2); expect(room.negotiating).toBe(true);
    expect(manager.requestFloor(room, "a", 3, 2).epoch).toBe(2);
  });

  it("proactively notifies and closes both peers through callbacks exactly once on expiry", () => {
    let now = 0; const { manager, room, a, b } = pair(new RoomManager(10, () => now));
    manager.requestFloor(room, "a", 1, 1); now = 10; manager.expire(); manager.expire();
    for (const peer of [a, b]) {
      expect(peer.send).toHaveBeenLastCalledWith({ v: 1, type: "error", generation: peer.generation, code: "room_expired" });
      expect(peer.close).toHaveBeenCalledExactlyOnceWith("room_expired");
    }
    expect(room.floor).toBeUndefined(); expect(room.participants.size).toBe(0); expect(manager.size()).toBe(0);
  });

  it("enforces room capacity and reclaims expired rooms", () => {
    let now = 0; const manager = new RoomManager(10, () => now, 5, 1); manager.create();
    expect(() => manager.create()).toThrow("room_capacity"); now = 10;
    expect(manager.create().room.expiresAt).toBe(20); expect(manager.size()).toBe(1);
  });
});
