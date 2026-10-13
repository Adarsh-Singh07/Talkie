import { pathToFileURL } from "node:url";
import { createSignalingServer, type ServerOptions, type IceServer } from "./server.js";
import { validateIceUrl, validateTurnRest, type TurnRestOptions } from "./ice.js";

export function optionsFromEnvironment(env: NodeJS.ProcessEnv): ServerOptions {
  const positive = (key: string, fallback: number, max: number) => {
    const raw = env[key] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let parsed: URL; try { parsed = new URL(origin); } catch { throw new Error("Invalid ALLOWED_ORIGINS"); }
    if (!["http:", "https:", "tauri:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/") || origin.endsWith("/")) throw new Error("Invalid ALLOWED_ORIGINS");
  }
  if (env.NODE_ENV === "production" && !allowedOrigins.length) throw new Error("ALLOWED_ORIGINS is required in production");
  const iceServers: IceServer[] = [];
  const roomTtlMs = positive("ROOM_TTL_SECONDS", 3600, 604800) * 1000;
  if (env.STUN_URL) iceServers.push({ urls: validateIceUrl(env.STUN_URL, "STUN_URL") });
  const turnUrls = env.TURN_URL === undefined ? [] : env.TURN_URL.split(",").map(value => validateIceUrl(value.trim(), "TURN_URL"));
  const staticConfigured = env.TURN_USERNAME !== undefined || env.TURN_CREDENTIAL !== undefined;
  const dynamicConfigured = env.TURN_SHARED_SECRET !== undefined || env.TURN_CREDENTIAL_TTL_SECONDS !== undefined;
  let turnRest: TurnRestOptions | undefined;
  if (staticConfigured && dynamicConfigured) throw new Error("Static TURN_USERNAME/TURN_CREDENTIAL cannot be mixed with TURN_SHARED_SECRET/TURN_CREDENTIAL_TTL_SECONDS");
  if (env.NODE_ENV === "production" && staticConfigured) throw new Error("Production TURN requires TURN_SHARED_SECRET; static TURN_USERNAME/TURN_CREDENTIAL are forbidden");
  if (dynamicConfigured || (env.NODE_ENV === "production" && turnUrls.length)) {
    if (!env.TURN_SHARED_SECRET || !turnUrls.length) throw new Error("TURN_URL and TURN_SHARED_SECRET are required together");
    turnRest = { urls: turnUrls, sharedSecret: env.TURN_SHARED_SECRET, ttlSeconds: positive("TURN_CREDENTIAL_TTL_SECONDS", 3900, 86400) };
    validateTurnRest(turnRest, roomTtlMs);
  } else if (turnUrls.length || staticConfigured) {
    if (!turnUrls.length || !env.TURN_USERNAME?.trim() || !env.TURN_CREDENTIAL?.trim() || env.TURN_USERNAME.length > 1024 || env.TURN_CREDENTIAL.length > 4096) throw new Error("TURN_URL, TURN_USERNAME and TURN_CREDENTIAL are required together");
    iceServers.push(...turnUrls.map(urls => ({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL })));
  }
  const heartbeatIntervalMs = positive("HEARTBEAT_INTERVAL_SECONDS", 15, 3600) * 1000;
  const heartbeatTimeoutMs = positive("HEARTBEAT_TIMEOUT_SECONDS", 45, 86400) * 1000;
  if (heartbeatTimeoutMs <= heartbeatIntervalMs) throw new Error("HEARTBEAT_TIMEOUT_SECONDS must exceed heartbeat interval");
  if (env.HOST !== undefined && !env.HOST.trim()) throw new Error("Invalid HOST");
  return {
    host: env.HOST ?? "127.0.0.1", port: positive("PORT", 8787, 65535), allowedOrigins, iceServers, turnRest,
    heartbeatIntervalMs, heartbeatTimeoutMs, maxMessageBytes: positive("MAX_MESSAGE_BYTES", 65536, 1048576),
    roomTtlMs, floorLeaseMs: positive("FLOOR_LEASE_SECONDS", 30, 3600) * 1000,
    rateLimitWindowMs: positive("RATE_LIMIT_WINDOW_SECONDS", 10, 3600) * 1000, maxMessagesPerWindow: positive("MAX_MESSAGES_PER_WINDOW", 100, 100000),
    maxSockets: positive("MAX_SOCKETS", 2000, 100000), maxRooms: positive("MAX_ROOMS", 1000, 100000), maxIpEntries: positive("MAX_IP_ENTRIES", 10000, 100000),
    maxUpgradesPerWindow: positive("MAX_UPGRADES_PER_WINDOW", 60, 100000), maxCreatesPerWindow: positive("MAX_CREATES_PER_WINDOW", 20, 100000), maxJoinsPerWindow: positive("MAX_JOINS_PER_WINDOW", 60, 100000),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = optionsFromEnvironment(process.env);
  const signaling = createSignalingServer(options);
  await signaling.listen();
  console.log(`Talkie signaling server listening on ${options.host}:${options.port}`);
  const shutdown = async () => { await signaling.close(); process.exit(0); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
