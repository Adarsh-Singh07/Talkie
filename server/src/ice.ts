import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export interface IceServer { urls: string; username?: string; credential?: string; }
/** Server-only configuration. Never serialize this object into a response. */
export interface TurnRestOptions { urls: string[]; sharedSecret: string; ttlSeconds: number; }

export function validateIceUrl(value: string, key: "STUN_URL" | "TURN_URL"): string {
  const match = /^(stun|stuns|turn|turns):([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::([0-9]+))?(?:\?transport=(udp|tcp))?$/.exec(value);
  if (!match || value.length > 2048) throw new Error(`Invalid ${key}`);
  const [, scheme, host, port, transport] = match;
  if ((key === "STUN_URL" ? !["stun", "stuns"].includes(scheme) || !!transport : !["turn", "turns"].includes(scheme)) ||
      (scheme === "turns" && transport === "udp") ||
      (host.startsWith("[") ? isIP(host.slice(1, -1)) !== 6 : !host.split(".").every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label))) ||
      (port !== undefined && (Number(port) < 1 || Number(port) > 65535))) throw new Error(`Invalid ${key}`);
  return value;
}

export function validateTurnRest(turn: TurnRestOptions, roomTtlMs: number): void {
  if (Buffer.byteLength(turn.sharedSecret, "utf8") < 32 || !turn.sharedSecret.trim()) throw new Error("TURN_SHARED_SECRET must contain at least 32 UTF-8 bytes");
  if (!Number.isSafeInteger(turn.ttlSeconds) || turn.ttlSeconds > 86400 || turn.ttlSeconds < Math.ceil(roomTtlMs / 1000) + 60) throw new Error("TURN_CREDENTIAL_TTL_SECONDS must be at least ROOM_TTL_SECONDS + 60 and at most 86400");
  if (!turn.urls.length) throw new Error("TURN_URL is required with TURN_SHARED_SECRET");
  for (const url of turn.urls) validateIceUrl(url, "TURN_URL");
}

/** Called only after room admission, separately for each acknowledgement recipient. */
export function issueIceServers(iceServers: IceServer[], turn?: TurnRestOptions): IceServer[] {
  if (!turn) return iceServers;
  const username = `${Math.floor(Date.now() / 1000) + turn.ttlSeconds}:${randomBytes(16).toString("hex")}`;
  const credential = createHmac("sha1", turn.sharedSecret).update(username).digest("base64");
  return [...iceServers, ...turn.urls.map(urls => ({ urls, username, credential }))];
}
