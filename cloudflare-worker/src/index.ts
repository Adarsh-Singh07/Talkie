const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 65_536;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_RESUME_TOKEN_LENGTH = 256;
const MAX_SDP_LENGTH = 32_768;
const MAX_ICE_LENGTH = 8_192;
const MAX_LEASE_ID_LENGTH = 128;
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const ROOM_TTL_SECONDS = 3_600;
const FLOOR_LEASE_MS = 30_000;
const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 100;
const MAX_SEEN_IDS = 128;
const MAX_ROOMS = 1_000;
const MAX_SOCKETS = 2_000;
const MAX_IP_ENTRIES = 10_000;
const MAX_UPGRADES_PER_WINDOW = 60;
const MAX_CREATES_PER_WINDOW = 20;
const MAX_JOINS_PER_WINDOW = 60;
const MAX_IDENTITIES_PER_ROOM = 128;
const CLOUDFLARE_TURN_TTL_SECONDS = 86_400;
const CLOUDFLARE_TURN_CACHE_TTL_MS = 15 * 60_000;
export const CLOUDFLARE_TURN_URLS = [
  "turn:turn.cloudflare.com:3478?transport=udp",
  "turn:turn.cloudflare.com:3478?transport=tcp",
  "turns:turn.cloudflare.com:5349?transport=tcp",
] as const;
const CLOUDFLARE_TURN_ENDPOINT = "https://rtc.live.cloudflare.com/v1/turn/keys";

export interface Env {
  ROOMS: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  ROOM_TTL_SECONDS?: string;
  MAX_MESSAGE_BYTES?: string;
  FLOOR_LEASE_SECONDS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  MAX_MESSAGES_PER_WINDOW?: string;
  MAX_ROOMS?: string;
  MAX_SOCKETS?: string;
  MAX_IP_ENTRIES?: string;
  MAX_UPGRADES_PER_WINDOW?: string;
  MAX_CREATES_PER_WINDOW?: string;
  MAX_JOINS_PER_WINDOW?: string;
  STUN_URL?: string;
  TURN_URL?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  TURN_SHARED_SECRET?: string;
  TURN_CREDENTIAL_TTL_SECONDS?: string;
  ICE_SERVERS_JSON?: string;
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;
}

type IceServer = { urls: string; username?: string; credential?: string };
export interface CloudflareTurnOptions {
  keyId: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  cacheTtlMs?: number;
}
type CloudflareTurnProvider = { getIceServers: () => Promise<IceServer[]> };
type Floor = { sessionId: string; generation: number; epoch: number; leaseId: string; leaseDurationMs: number; expiresAt: number; speaking: boolean };
type RoomRow = { code: string; expires_at: number; epoch: number; negotiating: number; floor_json: string | null };
type IdentityRow = { resume_hash: string; generation: number };
type Attachment = {
  connectionId: string;
  ip: string;
  roomCode?: string;
  sessionId?: string;
  generation?: number;
  ready?: boolean;
  messageTimes?: number[];
  seenIds?: string[];
};
type ClientMessage =
  | { v: 1; id: string; type: "create"; sessionId: string; generation: number }
  | { v: 1; id: string; type: "join"; roomCode: string; sessionId: string; generation: number; resumeToken?: string }
  | { v: 1; id: string; type: "ready" | "leave"; generation: number }
  | { v: 1; id: string; type: "signal"; kind: "offer" | "answer" | "ice"; payload: string; generation: number; epoch: number }
  | { v: 1; id: string; type: "request_floor"; generation: number; epoch: number }
  | { v: 1; id: string; type: "release_floor"; generation: number; epoch: number; leaseId: string }
  | { v: 1; id: string; type: "speaking"; generation: number; epoch: number; leaseId: string; speaking: boolean }
  | { v: 1; id: string; type: "ping" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function numberSetting(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error("invalid_configuration");
  return value;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 0x8000) result += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(result);
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function hashToken(token: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}

function equalBytes(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function canonicalOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "tauri:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) return undefined;
    const host = parsed.host.toLowerCase();
    if (!host) return undefined;
    return `${parsed.protocol}//${host}`;
  } catch {
    return undefined;
  }
}

export function allowedOrigin(value: string | null, configured: string | undefined): boolean {
  if (!value || !configured) return false;
  const origin = canonicalOrigin(value);
  if (!origin) return false;
  return configured.split(",").map(item => canonicalOrigin(item.trim())).filter((item): item is string => !!item).includes(origin);
}

function hasPort53(url: string): boolean {
  return /(?:^|\])(?::53)(?:\?|$)/.test(url) || /:[^:]*:53(?:\?|$)/.test(url);
}

function isCloudflareTurnUrl(url: string): boolean {
  return /^turns?:turn\.cloudflare\.com(?::|$)/i.test(url);
}

/** Normalize Cloudflare's response without exposing port-53 or incomplete TURN entries. */
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

export function createCloudflareTurnProvider(options: CloudflareTurnOptions): CloudflareTurnProvider {
  if (!options.keyId.trim() || options.keyId.length > 512 || !options.apiToken.trim() || options.apiToken.length > 4096) throw new Error("invalid_cloudflare_turn_configuration");
  const cacheTtlMs = options.cacheTtlMs ?? CLOUDFLARE_TURN_CACHE_TTL_MS;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 10 * 60_000 || cacheTtlMs > 30 * 60_000) throw new Error("invalid_cloudflare_turn_configuration");
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
      return servers.map(server => ({ ...server }));
    } catch {
      return [];
    }
  };
  return {
    getIceServers: () => {
      const current = now();
      if (cached && cached.expiresAt > current) return Promise.resolve(cached.iceServers.map(server => ({ ...server })));
      if (!inFlight) inFlight = request().finally(() => { inFlight = undefined; });
      return inFlight.then(servers => servers.map(server => ({ ...server })));
    },
  };
}

function validString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function exactKeys(value: Record<string, unknown>, ...allowed: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && allowed.every(key => keys.includes(key));
}

export function parseClientMessage(raw: string | ArrayBuffer, maxBytes = MAX_MESSAGE_BYTES): ClientMessage {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid_message_limit");
  const text = typeof raw === "string" ? raw : decoder.decode(new Uint8Array(raw));
  if (encoder.encode(text).byteLength > maxBytes) throw new Error("message_too_large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("invalid_json"); }
  if (!value || typeof value !== "object") throw new Error("invalid_message");
  const m = value as Record<string, unknown>;
  if (m.v !== PROTOCOL_VERSION || !validString(m.id, 128) || !validString(m.type, 16)) throw new Error("invalid_envelope");
  const generation = m.generation;
  if (m.type !== "ping" && (!Number.isSafeInteger(generation) || (generation as number) < 0)) throw new Error("invalid_message");
  if ((m.type === "ready" || m.type === "leave") && exactKeys(m, "v", "id", "type", "generation")) return { v: 1, id: m.id, type: m.type, generation: generation as number };
  if (m.type === "ping" && exactKeys(m, "v", "id", "type")) return { v: 1, id: m.id, type: "ping" };
  if (m.type === "create" && exactKeys(m, "v", "id", "type", "sessionId", "generation") && validString(m.sessionId, MAX_SESSION_ID_LENGTH)) return { v: 1, id: m.id, type: "create", sessionId: m.sessionId, generation: generation as number };
  if (m.type === "join" && (exactKeys(m, "v", "id", "type", "roomCode", "sessionId", "generation") || (exactKeys(m, "v", "id", "type", "roomCode", "sessionId", "generation", "resumeToken") && validString(m.resumeToken, MAX_RESUME_TOKEN_LENGTH))) && typeof m.roomCode === "string" && ROOM_CODE_PATTERN.test(m.roomCode) && validString(m.sessionId, MAX_SESSION_ID_LENGTH)) return { v: 1, id: m.id, type: "join", roomCode: m.roomCode, sessionId: m.sessionId, generation: generation as number, ...(typeof m.resumeToken === "string" ? { resumeToken: m.resumeToken } : {}) };
  if (m.type === "signal" && exactKeys(m, "v", "id", "type", "kind", "payload", "generation", "epoch") && Number.isSafeInteger(m.epoch) && (m.epoch as number) > 0 && (m.kind === "offer" || m.kind === "answer" || m.kind === "ice") && validString(m.payload, m.kind === "ice" ? MAX_ICE_LENGTH : MAX_SDP_LENGTH)) return { v: 1, id: m.id, type: "signal", kind: m.kind, payload: m.payload, generation: generation as number, epoch: m.epoch as number };
  const validEpoch = Number.isSafeInteger(m.epoch) && (m.epoch as number) > 0;
  if (m.type === "request_floor" && exactKeys(m, "v", "id", "type", "generation", "epoch") && validEpoch) return { v: 1, id: m.id, type: "request_floor", generation: generation as number, epoch: m.epoch as number };
  if (m.type === "release_floor" && exactKeys(m, "v", "id", "type", "generation", "epoch", "leaseId") && validEpoch && validString(m.leaseId, MAX_LEASE_ID_LENGTH)) return { v: 1, id: m.id, type: "release_floor", generation: generation as number, epoch: m.epoch as number, leaseId: m.leaseId };
  if (m.type === "speaking" && exactKeys(m, "v", "id", "type", "generation", "epoch", "leaseId", "speaking") && validEpoch && validString(m.leaseId, MAX_LEASE_ID_LENGTH) && typeof m.speaking === "boolean") return { v: 1, id: m.id, type: "speaking", generation: generation as number, epoch: m.epoch as number, leaseId: m.leaseId, speaking: m.speaking };
  throw new Error("invalid_message");
}

function validateIceUrl(value: string, kind: "STUN_URL" | "TURN_URL"): string {
  const match = /^(stun|stuns|turn|turns):([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::([0-9]+))?(?:\?transport=(udp|tcp))?$/.exec(value);
  if (!match || value.length > 2048) throw new Error(`invalid_${kind.toLowerCase()}`);
  const [, scheme, host, port, transport] = match;
  if ((kind === "STUN_URL" ? !["stun", "stuns"].includes(scheme) || !!transport : !["turn", "turns"].includes(scheme)) || (scheme === "turns" && transport === "udp") || (port !== undefined && (Number(port) < 1 || Number(port) > 65_535))) throw new Error(`invalid_${kind.toLowerCase()}`);
  if (host.startsWith("[")) {
    if (!/^[0-9a-fA-F:]+$/.test(host.slice(1, -1)) || !host.includes(":")) throw new Error(`invalid_${kind.toLowerCase()}`);
  } else if (!host.split(".").every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label))) throw new Error(`invalid_${kind.toLowerCase()}`);
  return value;
}

type IceConfig = { stun: string[]; turn: string[]; username?: string; credential?: string; sharedSecret?: string; credentialTtlSeconds: number; roomTtlSeconds: number; extra: IceServer[]; cloudflareTurn?: CloudflareTurnOptions };

function loadIceConfig(env: Env, roomTtlSeconds: number): IceConfig {
  const stun = env.STUN_URL ? [validateIceUrl(env.STUN_URL, "STUN_URL")] : [];
  const turn = env.TURN_URL === undefined ? [] : env.TURN_URL.split(",").map(value => validateIceUrl(value.trim(), "TURN_URL"));
  const staticConfigured = env.TURN_USERNAME !== undefined || env.TURN_CREDENTIAL !== undefined;
  const dynamicConfigured = env.TURN_SHARED_SECRET !== undefined || env.TURN_CREDENTIAL_TTL_SECONDS !== undefined;
  if (staticConfigured && dynamicConfigured) throw new Error("invalid_turn_configuration");
  if (turn.length && staticConfigured && (!env.TURN_USERNAME?.trim() || !env.TURN_CREDENTIAL?.trim() || env.TURN_USERNAME.length > 1_024 || env.TURN_CREDENTIAL.length > 4_096)) throw new Error("invalid_turn_configuration");
  if (env.TURN_SHARED_SECRET !== undefined && (new TextEncoder().encode(env.TURN_SHARED_SECRET).byteLength < 32 || !env.TURN_SHARED_SECRET.trim())) throw new Error("invalid_turn_configuration");
  if ((staticConfigured && !turn.length) || (dynamicConfigured && (!turn.length || !env.TURN_SHARED_SECRET?.trim()))) throw new Error("invalid_turn_configuration");
  const credentialTtlSeconds = numberSetting(env.TURN_CREDENTIAL_TTL_SECONDS, 3_900, roomTtlSeconds + 60, 86_400);
  let extra: IceServer[] = [];
  if (env.ICE_SERVERS_JSON) {
    if (env.ICE_SERVERS_JSON.length > 16_384) throw new Error("invalid_ice_configuration");
    let value: unknown;
    try { value = JSON.parse(env.ICE_SERVERS_JSON); } catch { throw new Error("invalid_ice_configuration"); }
    if (!Array.isArray(value) || value.length > 16) throw new Error("invalid_ice_configuration");
    extra = value.map(item => {
      if (!item || typeof item !== "object" || typeof (item as { urls?: unknown }).urls !== "string") throw new Error("invalid_ice_configuration");
      const entry = item as { urls: string; username?: unknown; credential?: unknown };
      const urls = /^(stun|stuns):/i.test(entry.urls) ? validateIceUrl(entry.urls, "STUN_URL") : validateIceUrl(entry.urls, "TURN_URL");
      if (entry.username !== undefined || entry.credential !== undefined) {
        if (typeof entry.username !== "string" || typeof entry.credential !== "string") throw new Error("invalid_ice_configuration");
        return { urls, username: entry.username, credential: entry.credential };
      }
      return { urls };
    });
  }
  const cloudflareConfigured = env.CF_TURN_KEY_ID !== undefined || env.CF_TURN_API_TOKEN !== undefined;
  let cloudflareTurn: CloudflareTurnOptions | undefined;
  if (cloudflareConfigured) {
    if (!env.CF_TURN_KEY_ID?.trim() || !env.CF_TURN_API_TOKEN?.trim() || env.CF_TURN_KEY_ID.length > 512 || env.CF_TURN_API_TOKEN.length > 4096) throw new Error("invalid_cloudflare_turn_configuration");
    cloudflareTurn = { keyId: env.CF_TURN_KEY_ID, apiToken: env.CF_TURN_API_TOKEN };
  }
  return { stun, turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL, sharedSecret: env.TURN_SHARED_SECRET, credentialTtlSeconds, roomTtlSeconds, extra, cloudflareTurn };
}

async function hmacSha1(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function issueIceServers(config: IceConfig, cloudflareTurn?: CloudflareTurnProvider): Promise<IceServer[]> {
  const result: IceServer[] = [...config.extra, ...config.stun.map(urls => ({ urls }))];
  if (cloudflareTurn) {
    const servers = await cloudflareTurn.getIceServers();
    if (servers.length) return servers;
  }
  if (!config.turn.length) return result;
  let username = config.username;
  let credential = config.credential;
  if (config.sharedSecret) {
    const nonce = new Uint8Array(16); crypto.getRandomValues(nonce);
    username = `${Math.floor(Date.now() / 1000) + config.credentialTtlSeconds}:${bytesToHex(nonce)}`;
    credential = await hmacSha1(config.sharedSecret, username);
  }
  return [...result, ...config.turn.map(urls => ({ urls, username, credential }))];
}

function json(data: unknown, status = 200, origin?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  if (origin) { headers.set("Access-Control-Allow-Origin", origin); headers.set("Vary", "Origin"); }
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers });
}

function requestIp(request: Request): string {
  const value = request.headers.get("CF-Connecting-IP")?.trim();
  return value && value.length <= 128 ? value : "unknown";
}

export class RoomState {
  private readonly ready: Promise<void>;
  private readonly queues = new Map<WebSocket, Promise<void>>();
  private readonly transient = new Map<WebSocket, { messageTimes: number[]; seenIds: string[] }>();
  private readonly limits: Required<Pick<IceConfig, "roomTtlSeconds">> & { maxMessageBytes: number; floorLeaseMs: number; rateWindowMs: number; maxMessages: number; maxRooms: number; maxSockets: number; maxIpEntries: number; maxUpgrades: number; maxCreates: number; maxJoins: number };
  private readonly ice: IceConfig;
  private readonly cloudflareTurn?: CloudflareTurnProvider;
  private readonly budgets = new Map<string, { expiresAt: number; upgrade: number; create: number; join: number }>();
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    const roomTtlSeconds = numberSetting(env.ROOM_TTL_SECONDS, ROOM_TTL_SECONDS, 1, 604_800);
    this.limits = {
      roomTtlSeconds,
      maxMessageBytes: numberSetting(env.MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES, 1, 1_048_576),
      floorLeaseMs: numberSetting(env.FLOOR_LEASE_SECONDS, FLOOR_LEASE_MS / 1_000, 1, 3_600) * 1_000,
      rateWindowMs: numberSetting(env.RATE_LIMIT_WINDOW_SECONDS, RATE_WINDOW_MS / 1_000, 1, 3_600) * 1_000,
      maxMessages: numberSetting(env.MAX_MESSAGES_PER_WINDOW, MAX_MESSAGES_PER_WINDOW, 1, 100_000),
      maxRooms: numberSetting(env.MAX_ROOMS, MAX_ROOMS, 0, 100_000),
      maxSockets: numberSetting(env.MAX_SOCKETS, MAX_SOCKETS, 0, 100_000),
      maxIpEntries: numberSetting(env.MAX_IP_ENTRIES, MAX_IP_ENTRIES, 0, 100_000),
      maxUpgrades: numberSetting(env.MAX_UPGRADES_PER_WINDOW, MAX_UPGRADES_PER_WINDOW, 0, 100_000),
      maxCreates: numberSetting(env.MAX_CREATES_PER_WINDOW, MAX_CREATES_PER_WINDOW, 0, 100_000),
      maxJoins: numberSetting(env.MAX_JOINS_PER_WINDOW, MAX_JOINS_PER_WINDOW, 0, 100_000),
    };
    this.ice = loadIceConfig(env, roomTtlSeconds);
    this.cloudflareTurn = this.ice.cloudflareTurn ? createCloudflareTurnProvider(this.ice.cloudflareTurn) : undefined;
    this.ready = state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec("CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, negotiating INTEGER NOT NULL DEFAULT 0, floor_json TEXT)");
      const roomColumns = state.storage.sql.exec("PRAGMA table_info(rooms)").toArray() as Array<{ name?: unknown }>;
      if (roomColumns.some(column => column.name === "invitation_hash")) {
        state.storage.sql.exec("CREATE TABLE rooms_v2 (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, negotiating INTEGER NOT NULL DEFAULT 0, floor_json TEXT)");
        state.storage.sql.exec("INSERT INTO rooms_v2 (code, expires_at, epoch, negotiating, floor_json) SELECT code, expires_at, epoch, negotiating, floor_json FROM rooms");
        state.storage.sql.exec("DROP TABLE rooms");
        state.storage.sql.exec("ALTER TABLE rooms_v2 RENAME TO rooms");
      }
      state.storage.sql.exec("CREATE TABLE IF NOT EXISTS identities (room_code TEXT NOT NULL, session_id TEXT NOT NULL, resume_hash TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY (room_code, session_id))");
      state.storage.sql.exec("CREATE INDEX IF NOT EXISTS rooms_expiry ON rooms (expires_at)");
      state.storage.sql.exec("CREATE INDEX IF NOT EXISTS identities_room ON identities (room_code)");
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (request.method === "POST" && new URL(request.url).pathname === "/rooms") return this.createHttpRoom(request);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade_required" }, 426);
    if (this.state.getWebSockets().length >= this.limits.maxSockets || !this.spend(requestIp(request), "upgrade")) return json({ error: "rate_limited" }, 429);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: Attachment = { connectionId: crypto.randomUUID(), ip: requestIp(request) };
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async createHttpRoom(request: Request): Promise<Response> {
    try {
      await this.expireDueRooms();
      if (!this.spend(requestIp(request), "create")) return json({ error: "rate_limited" }, 429);
      const room = await this.createRoom();
      return json({ v: 1, roomCode: room.code, expiresAt: room.expiresAt }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      return json({ error: code === "room_capacity" ? code : "invalid_request" }, code === "room_capacity" ? 503 : 400);
    }
  }

  private sql<T = Record<string, unknown>>(query: string, ...values: (string | number | null)[]): T[] {
    return this.state.storage.sql.exec(query, ...values).toArray() as T[];
  }

  private async createRoom(): Promise<{ code: string; expiresAt: number }> {
    await this.expireDueRooms();
    const count = this.sql<{ count: number }>("SELECT COUNT(*) AS count FROM rooms")[0]?.count ?? 0;
    if (count >= this.limits.maxRooms) throw new Error("room_capacity");
    let code = "";
    do { code = this.randomRoomCode(); } while (this.sql("SELECT code FROM rooms WHERE code = ?", code).length);
    const expiresAt = Date.now() + this.limits.roomTtlSeconds * 1_000;
    this.sql("INSERT INTO rooms (code, expires_at) VALUES (?, ?)", code, expiresAt);
    await this.scheduleAlarm();
    return { code, expiresAt };
  }

  private randomRoomCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint8Array(ROOM_CODE_LENGTH); crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
  }

  private attachment(ws: WebSocket): Attachment {
    const value = ws.deserializeAttachment() as Attachment | null;
    if (!value || typeof value.connectionId !== "string" || typeof value.ip !== "string") throw new Error("connection_state_missing");
    const state = this.transient.get(ws) ?? { messageTimes: [], seenIds: [] };
    return { ...value, messageTimes: state.messageTimes, seenIds: state.seenIds };
  }

  private saveAttachment(ws: WebSocket, value: Attachment): void {
    const { messageTimes = [], seenIds = [], ...persistent } = value;
    this.transient.set(ws, { messageTimes, seenIds });
    ws.serializeAttachment(persistent);
  }

  private enqueue(ws: WebSocket, message: string | ArrayBuffer): void {
    const previous = this.queues.get(ws) ?? Promise.resolve();
    const current = previous.then(() => this.handleMessage(ws, message)).catch(() => undefined).finally(() => {
      if (this.queues.get(ws) === current) this.queues.delete(ws);
    });
    this.queues.set(ws, current);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void { this.enqueue(ws, message); }
  webSocketClose(ws: WebSocket): void { this.transient.delete(ws); void this.detach(ws); }
  webSocketError(ws: WebSocket): void { this.transient.delete(ws); void this.detach(ws); }

  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ready;
    let attachment: Attachment;
    try { attachment = this.attachment(ws); } catch { return; }
    const now = Date.now();
    attachment.messageTimes = (attachment.messageTimes ?? []).filter(time => now - time < this.limits.rateWindowMs);
    if (attachment.messageTimes.length >= this.limits.maxMessages) { ws.close(1008, "rate_limited"); return; }
    attachment.messageTimes.push(now);
    this.saveAttachment(ws, attachment);
    if (raw instanceof ArrayBuffer) { ws.close(1003, "binary_not_supported"); return; }
    let message: ClientMessage;
    try { message = parseClientMessage(raw, this.limits.maxMessageBytes); } catch (error) { this.send(ws, { v: 1, type: "error", code: error instanceof Error ? error.message : "invalid_message" }); return; }
    attachment.seenIds ??= [];
    if (attachment.seenIds.includes(message.id)) { this.send(ws, { v: 1, type: "error", id: message.id, code: "replayed_message" }); return; }
    attachment.seenIds.push(message.id); if (attachment.seenIds.length > MAX_SEEN_IDS) attachment.seenIds.shift(); this.saveAttachment(ws, attachment);
    if (message.type === "ping") { this.send(ws, { v: 1, type: "pong", id: message.id }); return; }
    try {
      if (message.type === "create" || message.type === "join") {
        if (attachment.roomCode) throw new Error("already_joined");
        if (!this.spend(attachment.ip, message.type)) throw new Error("rate_limited");
        const result = message.type === "create" ? await this.admitCreate(ws, attachment, message) : await this.admitJoin(ws, attachment, message);
        this.send(ws, result.ack);
        for (const peerMessage of result.peerMessages) this.send(peerMessage.ws, peerMessage.message);
        if (result.replacedFloor) this.broadcast(result.roomCode, { v: 1, type: "floor_released", sessionId: result.replacedFloor.sessionId, leaseId: result.replacedFloor.leaseId, epoch: result.replacedFloor.epoch });
        return;
      }
      if (!attachment.roomCode || !attachment.sessionId || attachment.generation === undefined) throw new Error("not_joined");
      const room = await this.room(attachment.roomCode);
      if (!room) return;
      if (message.generation !== attachment.generation) throw new Error("stale_generation");
      if (message.type === "leave") {
        await this.detach(ws);
        this.send(ws, { v: 1, type: "left", id: message.id, generation: message.generation });
      } else if (message.type === "ready") {
        attachment.ready = true; this.saveAttachment(ws, attachment); await this.maybeStartNegotiation(room);
      } else if (message.type === "signal") {
        this.assertFloorContextNotNeeded(room, attachment, message.epoch);
        this.broadcast(room.code, message, ws, value => ({ ...value.message, generation: this.attachment(value.ws).generation }));
      } else if (message.type === "request_floor") {
        this.assertFloorContext(room, attachment, message.epoch);
        const expired = await this.expireFloor(room); if (expired) this.broadcast(room.code, { v: 1, type: "floor_expired", sessionId: expired.sessionId, leaseId: expired.leaseId, epoch: expired.epoch });
        const current = await this.room(room.code); if (!current) return;
        const floor = JSON.parse(current.floor_json ?? "null") as Floor | null; if (floor) throw new Error("floor_busy");
        const next: Floor = { sessionId: attachment.sessionId, generation: attachment.generation, epoch: message.epoch, leaseId: crypto.randomUUID(), leaseDurationMs: this.limits.floorLeaseMs, expiresAt: Date.now() + this.limits.floorLeaseMs, speaking: false };
        this.sql("UPDATE rooms SET floor_json = ? WHERE code = ?", JSON.stringify(next), room.code);
        this.broadcast(room.code, { v: 1, type: "floor_granted", id: message.id, sessionId: next.sessionId, leaseId: next.leaseId, epoch: next.epoch, expiresAt: next.expiresAt, leaseDurationMs: next.leaseDurationMs });
        await this.scheduleAlarm();
      } else if (message.type === "release_floor") {
        this.assertFloorContext(room, attachment, message.epoch);
        const expired = await this.expireFloor(room); if (expired) this.broadcast(room.code, { v: 1, type: "floor_expired", sessionId: expired.sessionId, leaseId: expired.leaseId, epoch: expired.epoch });
        const current = await this.room(room.code); if (!current) return; const floor = JSON.parse(current.floor_json ?? "null") as Floor | null;
        if (floor && floor.sessionId === attachment.sessionId && floor.generation === attachment.generation && floor.leaseId === message.leaseId) { this.sql("UPDATE rooms SET floor_json = NULL WHERE code = ?", room.code); this.broadcast(room.code, { v: 1, type: "floor_released", id: message.id, sessionId: attachment.sessionId, leaseId: floor.leaseId, epoch: floor.epoch }); }
      } else if (message.type === "speaking") {
        this.assertFloorContext(room, attachment, message.epoch);
        const expired = await this.expireFloor(room); if (expired) { this.broadcast(room.code, { v: 1, type: "floor_expired", sessionId: expired.sessionId, leaseId: expired.leaseId, epoch: expired.epoch }); throw new Error("floor_expired"); }
        const current = await this.room(room.code); if (!current) return; const floor = JSON.parse(current.floor_json ?? "null") as Floor | null;
        if (!floor) throw new Error("floor_expired"); if (floor.sessionId !== attachment.sessionId || floor.generation !== attachment.generation || floor.leaseId !== message.leaseId) throw new Error("invalid_floor_lease");
        floor.speaking = message.speaking; this.sql("UPDATE rooms SET floor_json = ? WHERE code = ?", JSON.stringify(floor), room.code); this.broadcast(room.code, { v: 1, type: "speaking", id: message.id, sessionId: floor.sessionId, leaseId: floor.leaseId, epoch: floor.epoch, speaking: floor.speaking });
      }
    } catch (error) {
      this.send(ws, { v: 1, type: "error", id: message.id, generation: "generation" in message ? message.generation : attachment.generation, epoch: "epoch" in message ? message.epoch : undefined, code: error instanceof Error ? error.message : "invalid_message" });
    }
  }

  private async admitCreate(ws: WebSocket, attachment: Attachment, message: Extract<ClientMessage, { type: "create" }>): Promise<{ ack: Record<string, unknown>; peerMessages: never[]; roomCode: string; replacedFloor?: Floor }> {
    const created = await this.createRoom();
    const ownResume = randomToken();
    this.sql("INSERT INTO identities (room_code, session_id, resume_hash, generation) VALUES (?, ?, ?, ?)", created.code, message.sessionId, await hashToken(ownResume), message.generation);
    attachment.roomCode = created.code; attachment.sessionId = message.sessionId; attachment.generation = message.generation; attachment.ready = false; this.saveAttachment(ws, attachment);
    return { ack: { v: 1, type: "created", id: message.id, roomCode: created.code, resumeToken: ownResume, participantCount: 1, generation: message.generation, iceServers: await issueIceServers(this.ice, this.cloudflareTurn) }, peerMessages: [], roomCode: created.code };
  }

  private async admitJoin(ws: WebSocket, attachment: Attachment, message: Extract<ClientMessage, { type: "join" }>): Promise<{ ack: Record<string, unknown>; peerMessages: Array<{ ws: WebSocket; message: Record<string, unknown> }>; roomCode: string; replacedFloor?: Floor }> {
    const room = await this.room(message.roomCode); if (!room) throw new Error("unauthorized_room");
    const identity = this.sql<IdentityRow>("SELECT resume_hash, generation FROM identities WHERE room_code = ? AND session_id = ?", room.code, message.sessionId)[0];
    if (identity && (!message.resumeToken || message.resumeToken.length > MAX_RESUME_TOKEN_LENGTH || !equalBytes(await hashToken(message.resumeToken), identity.resume_hash))) throw new Error("invalid_resume_token");
    if (!identity && message.resumeToken !== undefined) throw new Error("invalid_resume_token");
    if (identity && message.generation <= identity.generation) throw new Error("stale_generation");
    const peers = this.participants(room.code).filter(item => this.attachment(item).sessionId !== message.sessionId);
    if (peers.length >= 2) throw new Error("room_full");
    if (!identity && this.sql<{ count: number }>("SELECT COUNT(*) AS count FROM identities WHERE room_code = ?", room.code)[0]?.count >= MAX_IDENTITIES_PER_ROOM) throw new Error("room_identity_limit");
    const existing = this.participants(room.code).find(item => this.attachment(item).sessionId === message.sessionId);
    const replacedFloor = existing ? JSON.parse(room.floor_json ?? "null") as Floor | null : undefined;
    if (existing) {
      await this.invalidate(room.code);
      for (const peer of this.participants(room.code)) if (peer !== existing) this.send(peer, { v: 1, type: "peer_left", generation: this.attachment(peer).generation, sessionId: message.sessionId });
      const old = this.attachment(existing); old.roomCode = undefined; old.sessionId = undefined; old.generation = undefined; old.ready = undefined; this.saveAttachment(existing, old); existing.close(1000, "session_replaced");
    }
    const ownResume = message.resumeToken ?? randomToken();
    if (identity) this.sql("UPDATE identities SET resume_hash = ?, generation = ? WHERE room_code = ? AND session_id = ?", identity.resume_hash, message.generation, room.code, message.sessionId);
    else this.sql("INSERT INTO identities (room_code, session_id, resume_hash, generation) VALUES (?, ?, ?, ?)", room.code, message.sessionId, await hashToken(ownResume), message.generation);
    attachment.roomCode = room.code; attachment.sessionId = message.sessionId; attachment.generation = message.generation; attachment.ready = false; this.saveAttachment(ws, attachment);
    const active = this.participants(room.code);
    const peerMessages: Array<{ ws: WebSocket; message: Record<string, unknown> }> = [];
    const peerIce = await issueIceServers(this.ice, this.cloudflareTurn);
    for (const peer of active) if (peer !== ws) peerMessages.push({ ws: peer, message: { v: 1, type: "joined", roomCode: room.code, participantCount: active.length, generation: this.attachment(peer).generation, iceServers: peerIce } });
    return { ack: { v: 1, type: "joined", id: message.id, roomCode: room.code, resumeToken: ownResume, participantCount: active.length, generation: message.generation, iceServers: await issueIceServers(this.ice, this.cloudflareTurn) }, peerMessages, roomCode: room.code, ...(replacedFloor ? { replacedFloor } : {}) };
  }

  private participants(code: string): WebSocket[] { return this.state.getWebSockets().filter(ws => { try { return this.attachment(ws).roomCode === code; } catch { return false; } }); }
  private send(ws: WebSocket, message: Record<string, unknown>): void { if (ws.readyState === WebSocket.OPEN) { const clean = Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined)); ws.send(JSON.stringify(clean)); } }
  private broadcast(code: string, message: Record<string, unknown>, except?: WebSocket, transform?: (value: { ws: WebSocket; message: Record<string, unknown> }) => Record<string, unknown>): void {
    for (const ws of this.participants(code)) if (ws !== except) { const value = { ws, message }; const output = transform ? transform(value) : { ...message, generation: this.attachment(ws).generation }; this.send(ws, output); }
  }

  private async room(code: string): Promise<RoomRow | undefined> {
    const room = this.sql<RoomRow>("SELECT code, expires_at, epoch, negotiating, floor_json FROM rooms WHERE code = ?", code)[0];
    if (room && room.expires_at <= Date.now()) { await this.expireRoom(room); return undefined; }
    return room;
  }

  private async invalidate(code: string): Promise<void> {
    this.sql("UPDATE rooms SET negotiating = 0, floor_json = NULL WHERE code = ?", code);
    for (const ws of this.participants(code)) { const attachment = this.attachment(ws); attachment.ready = false; this.saveAttachment(ws, attachment); }
  }

  private async detach(ws: WebSocket): Promise<void> {
    let attachment: Attachment; try { attachment = this.attachment(ws); } catch { return; }
    const code = attachment.roomCode; const sessionId = attachment.sessionId; if (!code || !sessionId) return;
    const room = await this.room(code); if (!room) return;
    const floor = JSON.parse(room.floor_json ?? "null") as Floor | null;
    await this.invalidate(code);
    attachment.roomCode = undefined; attachment.sessionId = undefined; attachment.generation = undefined; attachment.ready = undefined; this.saveAttachment(ws, attachment);
    if (floor) this.broadcast(code, { v: 1, type: "floor_released", sessionId: floor.sessionId, leaseId: floor.leaseId, epoch: floor.epoch });
    this.broadcast(code, { v: 1, type: "peer_left", sessionId });
  }

  private assertFloorContext(room: RoomRow, attachment: Attachment, epoch: number): void {
    const peers = this.participants(room.code); if (room.negotiating !== 1 || room.epoch !== epoch || peers.length !== 2 || peers.some(ws => !this.attachment(ws).ready)) throw new Error("stale_epoch");
  }
  private assertFloorContextNotNeeded(room: RoomRow, attachment: Attachment, epoch: number): void { if (room.negotiating !== 1 || room.epoch !== epoch || !this.participants(room.code).some(ws => ws === this.findSocket(attachment))) throw new Error("stale_epoch"); }
  private findSocket(attachment: Attachment): WebSocket | undefined { return this.state.getWebSockets().find(ws => { try { return this.attachment(ws).connectionId === attachment.connectionId; } catch { return false; } }); }

  private async maybeStartNegotiation(room: RoomRow): Promise<void> {
    const peers = this.participants(room.code); if (room.negotiating === 1 || peers.length !== 2 || peers.some(ws => !this.attachment(ws).ready)) return;
    const epoch = room.epoch + 1; this.sql("UPDATE rooms SET negotiating = 1, epoch = ?, floor_json = NULL WHERE code = ?", epoch, room.code);
    let offerer = true; for (const ws of peers) { const attachment = this.attachment(ws); this.send(ws, { v: 1, type: "peer_ready", generation: attachment.generation, epoch, offerer }); offerer = false; }
  }

  private async expireFloor(room: RoomRow): Promise<Floor | undefined> {
    const floor = JSON.parse(room.floor_json ?? "null") as Floor | null;
    if (!floor || floor.expiresAt > Date.now()) return undefined;
    this.sql("UPDATE rooms SET floor_json = NULL WHERE code = ?", room.code); return floor;
  }

  private async expireDueRooms(): Promise<void> {
    const rooms = this.sql<RoomRow>("SELECT code, expires_at, epoch, negotiating, floor_json FROM rooms WHERE expires_at <= ?", Date.now());
    for (const room of rooms) await this.expireRoom(room);
  }

  private async expireRoom(room: RoomRow): Promise<void> {
    this.sql("DELETE FROM identities WHERE room_code = ?", room.code); this.sql("DELETE FROM rooms WHERE code = ?", room.code);
    for (const ws of this.participants(room.code)) { const attachment = this.attachment(ws); this.send(ws, { v: 1, type: "error", generation: attachment.generation, code: "room_expired" }); attachment.roomCode = undefined; attachment.sessionId = undefined; attachment.generation = undefined; this.saveAttachment(ws, attachment); ws.close(1000, "room_expired"); }
    await this.scheduleAlarm();
  }

  async alarm(): Promise<void> { await this.ready; await this.expireDueRooms(); for (const room of this.sql<RoomRow>("SELECT code, expires_at, epoch, negotiating, floor_json FROM rooms WHERE floor_json IS NOT NULL")) { const floor = JSON.parse(room.floor_json ?? "null") as Floor | null; if (floor && floor.expiresAt <= Date.now() && room.negotiating === 1 && floor.epoch === room.epoch) { this.sql("UPDATE rooms SET floor_json = NULL WHERE code = ?", room.code); this.broadcast(room.code, { v: 1, type: "floor_expired", sessionId: floor.sessionId, leaseId: floor.leaseId, epoch: floor.epoch }); } } await this.scheduleAlarm(); }

  private async scheduleAlarm(): Promise<void> {
    const next = this.sql<{ expires_at: number }>("SELECT MIN(expires_at) AS expires_at FROM rooms")[0]?.expires_at;
    const floor = this.sql<{ floor_json: string | null }>("SELECT floor_json FROM rooms WHERE floor_json IS NOT NULL").map(row => { try { return JSON.parse(row.floor_json ?? "null") as Floor | null; } catch { return null; } }).filter((value): value is Floor => !!value).map(value => value.expiresAt).sort((a, b) => a - b)[0];
    if (next !== undefined || floor !== undefined) await this.state.storage.setAlarm(Math.max(Date.now() + 1, Math.min(next ?? Number.MAX_SAFE_INTEGER, floor ?? Number.MAX_SAFE_INTEGER)));
  }

  private spend(ip: string, kind: "upgrade" | "create" | "join"): boolean {
    const now = Date.now(); for (const [key, value] of this.budgets) if (value.expiresAt <= now) this.budgets.delete(key);
    let entry = this.budgets.get(ip); if (!entry) { if (this.budgets.size >= this.limits.maxIpEntries) return false; entry = { expiresAt: now + this.limits.rateWindowMs, upgrade: 0, create: 0, join: 0 }; this.budgets.set(ip, entry); }
    const cap = kind === "upgrade" ? this.limits.maxUpgrades : kind === "create" ? this.limits.maxCreates : this.limits.maxJoins; if (entry[kind] >= cap) return false; entry[kind]++; return true;
  }
}

async function workerFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin_not_allowed" }, 403);
  if (url.pathname === "/health" && request.method === "GET") return json({ status: "ok" }, 200, origin ?? undefined);
  if (!allowedOrigin(origin, env.ALLOWED_ORIGINS)) return json({ error: "origin_not_allowed" }, 403);
  if (request.method === "OPTIONS" && url.pathname === "/rooms") {
    const response = json(null, 204, origin!); response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS"); response.headers.set("Access-Control-Allow-Headers", "Content-Type"); return response;
  }
  if (request.method === "POST" && url.pathname === "/rooms") {
    const response = await env.ROOMS.get(env.ROOMS.idFromName("global")).fetch(request);
    return withCors(response, origin!);
  }
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return env.ROOMS.get(env.ROOMS.idFromName("global")).fetch(request);
  return json({ error: "not_found" }, 404, origin ?? undefined);
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default { fetch: workerFetch } satisfies ExportedHandler<Env>;
