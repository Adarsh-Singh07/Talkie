import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export interface IceServer { urls: string; username?: string; credential?: string; }
/** Server-only configuration. Never serialize this object into a response. */
export interface TurnRestOptions { urls: string[]; sharedSecret: string; ttlSeconds: number; }
/** Server-only Cloudflare Realtime TURN configuration. */
export interface CloudflareTurnOptions {
  keyId: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  cacheTtlMs?: number;
}

export const CLOUDFLARE_TURN_TTL_SECONDS = 86_400;
export const CLOUDFLARE_TURN_CACHE_TTL_MS = 15 * 60_000;
export const CLOUDFLARE_TURN_URLS = [
  "turn:turn.cloudflare.com:3478?transport=udp",
  "turn:turn.cloudflare.com:3478?transport=tcp",
  "turns:turn.cloudflare.com:5349?transport=tcp",
] as const;
const CLOUDFLARE_TURN_ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys";

function cloneIceServers(iceServers: IceServer[]): IceServer[] {
  return iceServers.map(server => ({ ...server }));
}

function hasPort53(url: string): boolean {
  return /(?:^|\])(?::53)(?:\?|$)/.test(url) || /:[^:]*:53(?:\?|$)/.test(url);
}

function isCloudflareTurnUrl(url: string): boolean {
  return /^turns?:turn\.cloudflare\.com(?::|$)/i.test(url);
}

/**
 * Accept only well-formed ICE entries returned by Cloudflare. TURN entries
 * must carry both credentials, and port 53 is deliberately excluded because
 * it is not a supported Cloudflare Realtime TURN service port.
 */
export function normalizeCloudflareIceServers(value: unknown): IceServer[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { iceServers?: unknown }).iceServers)) return [];
  const result: IceServer[] = [];
  let turnCredentials: { username: string; credential: string } | undefined;
  for (const raw of (value as { iceServers: unknown[] }).iceServers) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(entry.urls) ? entry.urls : [entry.urls])
      .filter((url): url is string => typeof url === "string")
      .filter(url => !hasPort53(url))
      .filter(url => {
        try { validateIceUrl(url, /^stuns?:/i.test(url) ? "STUN_URL" : "TURN_URL"); return true; } catch { return false; }
      });
    for (const url of urls) {
      const isTurn = /^turns?:/i.test(url);
      if (isTurn && (typeof entry.username !== "string" || !entry.username || typeof entry.credential !== "string" || !entry.credential)) continue;
      if (!isTurn && (entry.username !== undefined || entry.credential !== undefined) && (typeof entry.username !== "string" || typeof entry.credential !== "string")) continue;
      if (isTurn && isCloudflareTurnUrl(url) && !turnCredentials) turnCredentials = { username: entry.username as string, credential: entry.credential as string };
      // STUN does not use credentials; do not unnecessarily expose the TURN
      // bearer credential on a credential-free server entry.
      result.push({ urls: url, ...(isTurn && typeof entry.username === "string" ? { username: entry.username } : {}), ...(isTurn && typeof entry.credential === "string" ? { credential: entry.credential } : {}) });
    }
  }
  if (turnCredentials) {
    for (const urls of CLOUDFLARE_TURN_URLS) {
      if (!result.some(server => server.urls === urls)) result.push({ urls, ...turnCredentials });
    }
  }
  return result;
}

/**
 * Fetch and cache Cloudflare's short-lived ICE credentials. Errors are
 * intentionally converted to an empty list so room admission can use its
 * configured coturn or STUN fallback without logging the API token.
 */
export function createCloudflareTurnProvider(options: CloudflareTurnOptions): { getIceServers: () => Promise<IceServer[]> } {
  if (!options.keyId.trim() || options.keyId.length > 512 || !options.apiToken.trim() || options.apiToken.length > 4096) throw new Error("Invalid Cloudflare TURN credentials");
  const cacheTtlMs = options.cacheTtlMs ?? CLOUDFLARE_TURN_CACHE_TTL_MS;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 10 * 60_000 || cacheTtlMs > 30 * 60_000) throw new Error("Invalid Cloudflare TURN cache TTL");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  let cached: { expiresAt: number; iceServers: IceServer[] } | undefined;
  let inFlight: Promise<IceServer[]> | undefined;

  const request = async (): Promise<IceServer[]> => {
    try {
      const response = await fetchImpl(`${CLOUDFLARE_TURN_ENDPOINT}/${encodeURIComponent(options.keyId)}/credentials/generate-ice-servers`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${options.apiToken}` },
        body: JSON.stringify({ ttl: CLOUDFLARE_TURN_TTL_SECONDS }),
      });
      if (!response.ok) return [];
      const servers = normalizeCloudflareIceServers(await response.json());
      if (!CLOUDFLARE_TURN_URLS.every(urls => servers.some(server => server.urls === urls))) return [];
      cached = { expiresAt: now() + cacheTtlMs, iceServers: servers };
      return cloneIceServers(servers);
    } catch {
      return [];
    }
  };

  return {
    getIceServers: () => {
      const current = now();
      if (cached && cached.expiresAt > current) return Promise.resolve(cloneIceServers(cached.iceServers));
      if (!inFlight) inFlight = request().finally(() => { inFlight = undefined; });
      return inFlight.then(cloneIceServers);
    },
  };
}

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
