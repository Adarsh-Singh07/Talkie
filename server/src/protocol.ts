export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 65_536;
export const MAX_ROOM_CODE_LENGTH = 64;
export const MAX_SESSION_ID_LENGTH = 128;
export const MAX_INVITATION_TOKEN_LENGTH = 256;
export const MAX_SDP_LENGTH = 32_768;
export const MAX_ICE_LENGTH = 8_192;
export const ROOM_CODE_LENGTH = 6;
export const MAX_LEASE_ID_LENGTH = 128;
export const MAX_RESUME_TOKEN_LENGTH = 256;

export type ClientMessage =
  | { v: 1; id: string; type: "create"; sessionId: string; generation: number }
  | { v: 1; id: string; type: "join"; roomCode: string; invitationToken: string; sessionId: string; generation: number; resumeToken?: string }
  | { v: 1; id: string; type: "ready" | "leave"; generation: number }
  | { v: 1; id: string; type: "signal"; kind: "offer" | "answer" | "ice"; payload: string; generation: number; epoch: number }
  | { v: 1; id: string; type: "request_floor"; generation: number; epoch: number }
  | { v: 1; id: string; type: "release_floor"; generation: number; epoch: number; leaseId: string }
  | { v: 1; id: string; type: "speaking"; generation: number; epoch: number; leaseId: string; speaking: boolean }
  | { v: 1; id: string; type: "ping" };

export type ServerMessage = Record<string, unknown>;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function parseMessage(raw: string | Buffer | ArrayBuffer | Buffer[], maxBytes = MAX_MESSAGE_BYTES): ClientMessage {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_message_limit");
  const bytes = typeof raw === "string"
    ? Buffer.from(raw, "utf8")
    : Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw as ArrayBuffer);
  if (bytes.byteLength > maxBytes) throw new Error("message_too_large");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("invalid_json"); }
  if (!value || typeof value !== "object") throw new Error("invalid_message");
  const m = value as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION || !boundedString(m.id, 128) || !boundedString(m.type, 16)) throw new Error("invalid_envelope");
  const keys = Object.keys(m);
  const exact = (...allowed: string[]) => keys.length === allowed.length && allowed.every(key => keys.includes(key));
  if (m.type !== "ping" && (!Number.isSafeInteger(m.generation) || (m.generation as number) < 0)) throw new Error("invalid_message");
  if ((m.type === "ready" || m.type === "leave") && exact("v", "id", "type", "generation")) return { v: 1, id: m.id, type: m.type, generation: m.generation as number };
  if (m.type === "ping" && exact("v", "id", "type")) return { v: 1, id: m.id, type: "ping" };
  if (m.type === "create" && exact("v", "id", "type", "sessionId", "generation") && boundedString(m.sessionId, MAX_SESSION_ID_LENGTH) && Number.isInteger(m.generation) && (m.generation as number) >= 0) {
    return { v: 1, id: m.id, type: "create", sessionId: m.sessionId, generation: m.generation as number };
  }
  if (m.type === "join" && (exact("v", "id", "type", "roomCode", "invitationToken", "sessionId", "generation") || (exact("v", "id", "type", "roomCode", "invitationToken", "sessionId", "generation", "resumeToken") && boundedString(m.resumeToken, MAX_RESUME_TOKEN_LENGTH))) && typeof m.roomCode === "string" && /^[A-Z0-9]{6}$/.test(m.roomCode) && boundedString(m.invitationToken, MAX_INVITATION_TOKEN_LENGTH) && boundedString(m.sessionId, MAX_SESSION_ID_LENGTH)) {
    return { v: 1, id: m.id, type: "join", roomCode: m.roomCode, invitationToken: m.invitationToken, sessionId: m.sessionId, generation: m.generation as number, ...(typeof m.resumeToken === "string" ? { resumeToken: m.resumeToken } : {}) };
  }
  if (m.type === "signal" && exact("v", "id", "type", "kind", "payload", "generation", "epoch") && Number.isSafeInteger(m.epoch) && (m.epoch as number) > 0 && (m.kind === "offer" || m.kind === "answer" || m.kind === "ice") && boundedString(m.payload, m.kind === "ice" ? MAX_ICE_LENGTH : MAX_SDP_LENGTH)) {
    return { v: 1, id: m.id, type: "signal", kind: m.kind, payload: m.payload, generation: m.generation as number, epoch: m.epoch as number };
  }
  const validEpoch = Number.isSafeInteger(m.epoch) && (m.epoch as number) > 0;
  if (m.type === "request_floor" && exact("v", "id", "type", "generation", "epoch") && validEpoch) return { v: 1, id: m.id, type: "request_floor", generation: m.generation as number, epoch: m.epoch as number };
  if (m.type === "release_floor" && exact("v", "id", "type", "generation", "epoch", "leaseId") && validEpoch && boundedString(m.leaseId, MAX_LEASE_ID_LENGTH)) return { v: 1, id: m.id, type: "release_floor", generation: m.generation as number, epoch: m.epoch as number, leaseId: m.leaseId };
  if (m.type === "speaking" && exact("v", "id", "type", "generation", "epoch", "leaseId", "speaking") && validEpoch && boundedString(m.leaseId, MAX_LEASE_ID_LENGTH) && typeof m.speaking === "boolean") return { v: 1, id: m.id, type: "speaking", generation: m.generation as number, epoch: m.epoch as number, leaseId: m.leaseId, speaking: m.speaking };
  throw new Error("invalid_message");
}
