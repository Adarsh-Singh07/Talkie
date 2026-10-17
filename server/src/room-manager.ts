import { randomBytes } from "node:crypto";
import { createResumeToken, hashResumeToken, tokensMatch } from "./security.js";
import { MAX_RESUME_TOKEN_LENGTH, ROOM_CODE_LENGTH, ROOM_CODE_PATTERN } from "./protocol.js";
import { randomUUID } from "node:crypto";

export interface Participant { sessionId: string; generation: number; send: (message: Record<string, unknown>) => void; close?: (reason: string) => void; ready?: boolean; }
export interface Floor { sessionId: string; generation: number; epoch: number; leaseId: string; leaseDurationMs: number; expiresAt: number; speaking: boolean; }
interface Identity { resumeHash: string; generation: number; }
export interface Room { code: string; expiresAt: number; participants: Map<string, Participant>; identities: Map<string, Identity>; floor?: Floor; epoch: number; negotiating: boolean; }

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  constructor(private readonly ttlMs = 3_600_000, private readonly now = () => Date.now(), private readonly leaseMs = 30_000, private readonly maxRooms = 1000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Invalid ttlMs");
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Invalid leaseMs");
    if (!Number.isSafeInteger(maxRooms) || maxRooms < 0) throw new Error("Invalid maxRooms");
  }

  create(): { room: Room } {
    if (this.size() >= this.maxRooms) throw new Error("room_capacity");
    let code = this.createRoomCode();
    while (this.rooms.has(code)) code = this.createRoomCode();
    const room: Room = { code, expiresAt: this.now() + this.ttlMs, participants: new Map(), identities: new Map(), epoch: 0, negotiating: false };
    this.rooms.set(code, room);
    return { room };
  }

  private createRoomCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(ROOM_CODE_LENGTH);
    return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
  }

  join(code: string, participant: Participant, resumeToken?: string): { room: Room; resumeToken: string; replacedFloor?: Floor } {
    const room = this.get(code);
    if (!ROOM_CODE_PATTERN.test(code) || !room) throw new Error("unauthorized_room");
    const identity = room.identities.get(participant.sessionId);
    // Retain identities after disconnect: knowing a disclosed sessionId must never be
    // enough to impersonate either a live or departed peer.
    if (identity && (typeof resumeToken !== "string" || resumeToken.length === 0 || resumeToken.length > MAX_RESUME_TOKEN_LENGTH || !tokensMatch(resumeToken, identity.resumeHash))) throw new Error("invalid_resume_token");
    if (!identity && resumeToken !== undefined) throw new Error("invalid_resume_token");
    if (identity && participant.generation <= identity.generation) throw new Error("stale_generation");
    if (room.participants.size >= 2 && !room.participants.has(participant.sessionId)) throw new Error("room_full");
    // Bound resume tombstones even if an authorized peer churns session IDs.
    if (!identity && room.identities.size >= 128) throw new Error("room_identity_limit");
    const existing = room.participants.get(participant.sessionId);
    const replacedFloor = existing ? room.floor : undefined;
    if (existing) {
      this.invalidate(room);
      for (const peer of room.participants.values()) if (peer !== existing) peer.send({ v: 1, type: "peer_left", generation: peer.generation, sessionId: existing.sessionId });
    }
    const ownResumeToken = resumeToken ?? createResumeToken();
    room.identities.set(participant.sessionId, { resumeHash: hashResumeToken(ownResumeToken), generation: participant.generation });
    participant.ready = false;
    room.participants.set(participant.sessionId, participant);
    existing?.close?.("session_replaced");
    return { room, resumeToken: ownResumeToken, replacedFloor };
  }

  remove(code: string, sessionId: string, participant?: Participant): { room: Room; floor?: Floor } | undefined {
    const room = this.get(code);
    if (!room) return undefined;
    if (!room.participants.has(sessionId) || (participant && room.participants.get(sessionId) !== participant)) return undefined;
    room.participants.delete(sessionId);
    const floor = room.floor;
    this.invalidate(room);
    return { room, floor };
  }

  private invalidate(room: Room): void {
    room.negotiating = false; room.floor = undefined;
    for (const participant of room.participants.values()) participant.ready = false;
  }

  ready(room: Room, participant: Participant): void {
    if (room.participants.get(participant.sessionId) !== participant) throw new Error("stale_generation");
    participant.ready = true;
    if (room.negotiating || room.participants.size !== 2 || [...room.participants.values()].some(peer => !peer.ready)) return;
    room.negotiating = true; room.epoch++;
    let offerer = true;
    for (const peer of room.participants.values()) {
      peer.send({ v: 1, type: "peer_ready", generation: peer.generation, epoch: room.epoch, offerer });
      offerer = false;
    }
  }

  get(code: string): Room | undefined {
    const room = this.rooms.get(code);
    if (room && room.expiresAt <= this.now()) {
      // Delete before callbacks so socket cleanup cannot re-enter expiry or remove
      // an unrelated replacement. Notify every participant even without traffic.
      this.rooms.delete(code);
      this.invalidate(room);
      const participants = [...room.participants.values()];
      room.participants.clear(); room.identities.clear();
      for (const participant of participants) {
        try { participant.send({ v: 1, type: "error", generation: participant.generation, code: "room_expired" }); }
        finally { participant.close?.("room_expired"); }
      }
      return undefined;
    }
    return room;
  }

  expire(): void { for (const code of this.rooms.keys()) this.get(code); }
  expireFloor(room: Room): Floor | undefined {
    if (room.floor && (!room.negotiating || room.floor.epoch !== room.epoch)) {
      room.floor = undefined;
      return undefined;
    }
    if (room.floor && room.floor.expiresAt <= this.now()) {
      const floor = room.floor;
      room.floor = undefined;
      return floor;
    }
    return undefined;
  }
  expireFloors(): Array<{ room: Room; floor: Floor }> {
    const expired: Array<{ room: Room; floor: Floor }> = [];
    for (const room of this.rooms.values()) {
      if (!this.get(room.code)) continue;
      const floor = this.expireFloor(room);
      if (floor) expired.push({ room, floor });
    }
    return expired;
  }
  assertFloorContext(room: Room, sessionId: string, generation: number, epoch: number): void {
    const participant = room.participants.get(sessionId);
    if (!participant || participant.generation !== generation) throw new Error("stale_generation");
    if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch !== room.epoch || !room.negotiating || room.participants.size !== 2 || [...room.participants.values()].some(peer => !peer.ready)) throw new Error("stale_epoch");
  }
  requestFloor(room: Room, sessionId: string, generation: number, epoch: number): Floor {
    this.assertFloorContext(room, sessionId, generation, epoch);
    this.expireFloor(room);
    if (room.floor) throw new Error("floor_busy");
    room.floor = { sessionId, generation, epoch, leaseId: randomUUID(), leaseDurationMs: this.leaseMs, expiresAt: this.now() + this.leaseMs, speaking: false };
    return room.floor;
  }
  releaseFloor(room: Room, sessionId: string, generation: number, epoch: number, leaseId: string): Floor | undefined {
    this.assertFloorContext(room, sessionId, generation, epoch);
    this.expireFloor(room);
    const floor = room.floor;
    if (!floor) return undefined;
    if (floor.sessionId !== sessionId || floor.generation !== generation || floor.leaseId !== leaseId) return undefined;
    room.floor = undefined; return floor;
  }
  setSpeaking(room: Room, sessionId: string, generation: number, epoch: number, leaseId: string, speaking: boolean): Floor {
    this.assertFloorContext(room, sessionId, generation, epoch);
    this.expireFloor(room);
    const floor = room.floor;
    if (!floor) throw new Error("floor_expired");
    if (floor.sessionId !== sessionId || floor.generation !== generation || floor.leaseId !== leaseId) throw new Error("invalid_floor_lease");
    floor.speaking = speaking; return floor;
  }
  size(): number { this.expire(); return this.rooms.size; }
}
