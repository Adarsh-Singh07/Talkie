import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseMessage, MAX_MESSAGE_BYTES } from "./protocol.js";
import { RoomManager, type Participant, type Room, type Floor } from "./room-manager.js";
import { issueIceServers, validateTurnRest, type IceServer, type TurnRestOptions } from "./ice.js";

export type { IceServer } from "./ice.js";
export interface ServerOptions {
  host?: string; port?: number; allowedOrigins?: string[]; heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number;
  maxMessageBytes?: number; roomTtlMs?: number; floorLeaseMs?: number; rateLimitWindowMs?: number; maxMessagesPerWindow?: number;
  maxSockets?: number; maxRooms?: number; maxIpEntries?: number; maxUpgradesPerWindow?: number; maxCreatesPerWindow?: number; maxJoinsPerWindow?: number; iceServers?: IceServer[];
  turnRest?: TurnRestOptions;
}

function integerOption(name: string, value: number | undefined, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`Invalid ${name}`);
  return result;
}

function canonicalOrigin(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) return value;
    let host = parsed.host;
    if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) host = parsed.hostname;
    return `${parsed.protocol}//${host}`;
  } catch {
    return value;
  }
}

export function createSignalingServer(options: ServerOptions = {}) {
  const maxMessageBytes = integerOption("maxMessageBytes", options.maxMessageBytes, MAX_MESSAGE_BYTES, 1, 1_048_576);
  const roomTtlMs = integerOption("roomTtlMs", options.roomTtlMs, 3_600_000, 1);
  if (options.turnRest) {
    validateTurnRest(options.turnRest, roomTtlMs);
    if (options.iceServers?.some(ice => /^turns?:/.test(ice.urls) || ice.username !== undefined || ice.credential !== undefined)) throw new Error("Static and dynamic TURN cannot be mixed");
  }
  const iceServers = () => issueIceServers(options.iceServers ?? [], options.turnRest);
  const floorLeaseMs = integerOption("floorLeaseMs", options.floorLeaseMs, 30_000, 1);
  const heartbeatIntervalMs = integerOption("heartbeatIntervalMs", options.heartbeatIntervalMs, 15_000, 1);
  const heartbeatTimeoutMs = integerOption("heartbeatTimeoutMs", options.heartbeatTimeoutMs, heartbeatIntervalMs * 3, heartbeatIntervalMs + 1);
  const windowMs = integerOption("rateLimitWindowMs", options.rateLimitWindowMs, 10_000, 1);
  const maxMessagesPerWindow = integerOption("maxMessagesPerWindow", options.maxMessagesPerWindow, 100, 0);
  const maxSockets = integerOption("maxSockets", options.maxSockets, 2_000, 0);
  const maxRooms = integerOption("maxRooms", options.maxRooms, 1_000, 0);
  const maxIpEntries = integerOption("maxIpEntries", options.maxIpEntries, 10_000, 0);
  const maxUpgradesPerWindow = integerOption("maxUpgradesPerWindow", options.maxUpgradesPerWindow, 60, 0);
  const maxCreatesPerWindow = integerOption("maxCreatesPerWindow", options.maxCreatesPerWindow, 20, 0);
  const maxJoinsPerWindow = integerOption("maxJoinsPerWindow", options.maxJoinsPerWindow, 60, 0);
  const allowedOrigins = options.allowedOrigins?.map(canonicalOrigin);
  const manager = new RoomManager(roomTtlMs, () => Date.now(), floorLeaseMs, maxRooms);
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.statusCode = request.method === "GET" && request.url === "/health" ? 200 : 404;
    response.end(JSON.stringify(response.statusCode === 200 ? { status: "ok" } : { error: "not_found" }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxMessageBytes });
  interface State { roomCode?: string; sessionId?: string; participant?: Participant; lastPongAt: number; messageTimes: number[]; seenIds: Set<string>; cleaned: boolean; }
  const sockets = new Map<WebSocket, State>();
  const budgets = new Map<string, { expiresAt: number; upgrade: number; create: number; join: number }>();
  function pruneBudgets(now: number): void { for (const [ip, entry] of budgets) if (entry.expiresAt <= now) budgets.delete(ip); }
  function spend(ip: string, kind: "upgrade" | "create" | "join"): boolean {
    const now = Date.now(); pruneBudgets(now);
    let entry = budgets.get(ip);
    if (!entry) {
      if (budgets.size >= maxIpEntries) return false;
      entry = { expiresAt: now + windowMs, upgrade: 0, create: 0, join: 0 }; budgets.set(ip, entry);
    }
    const cap = kind === "upgrade" ? maxUpgradesPerWindow : kind === "create" ? maxCreatesPerWindow : maxJoinsPerWindow;
    if (entry[kind] >= cap) return false;
    entry[kind]++; return true;
  }
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if ((allowedOrigins?.length && (!origin || !allowedOrigins.includes(canonicalOrigin(origin)))) || wss.clients.size >= maxSockets || !spend(request.socket.remoteAddress ?? "unknown", "upgrade")) { socket.destroy(); return; }
    try {
      wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
    } catch {
      socket.destroy();
    }
  });
  function detach(state: State): void {
    if (state.roomCode && state.sessionId) {
      const removed = manager.remove(state.roomCode, state.sessionId, state.participant);
      if (removed) {
        if (removed.floor) broadcast(removed.room, { v: 1, type: "floor_released", sessionId: removed.floor.sessionId, leaseId: removed.floor.leaseId, epoch: removed.floor.epoch });
        broadcast(removed.room, { v: 1, type: "peer_left", sessionId: state.sessionId });
      }
    }
    state.roomCode = undefined; state.sessionId = undefined; state.participant = undefined;
  }
  function notifyFloorExpired(room: Room, floor: Floor): void {
    if (room.negotiating && floor.epoch === room.epoch) broadcast(room, { v: 1, type: "floor_expired", sessionId: floor.sessionId, leaseId: floor.leaseId, epoch: floor.epoch });
  }
  wss.on("connection", (ws, request) => {
    const state: State = { lastPongAt: Date.now(), messageTimes: [], seenIds: new Set(), cleaned: false };
    sockets.set(ws, state);
    const send = (message: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    const cleanup = () => {
      if (state.cleaned) return;
      state.cleaned = true;
      detach(state);
      sockets.delete(ws);
    };
    ws.on("close", cleanup);
    ws.on("error", () => { cleanup(); ws.terminate(); });
    ws.on("pong", () => { state.lastPongAt = Date.now(); });
    ws.on("message", (raw, isBinary) => {
      if (state.cleaned) return;
      let id: string | undefined;
      let requestGeneration: number | undefined;
      let requestEpoch: number | undefined;
      try {
        const now = Date.now();
        state.messageTimes = state.messageTimes.filter(time => now - time < windowMs);
        if (state.messageTimes.length >= maxMessagesPerWindow) { cleanup(); ws.close(1008, "rate_limited"); return; }
        state.messageTimes.push(now);
        if (isBinary) { cleanup(); ws.close(1003, "binary_not_supported"); return; }
        const message = parseMessage(raw, maxMessageBytes); id = message.id;
        requestGeneration = 'generation' in message ? message.generation : undefined;
        requestEpoch = 'epoch' in message ? message.epoch : undefined;
        if (state.seenIds.has(message.id)) throw new Error("replayed_message");
        state.seenIds.add(message.id);
        if (state.seenIds.size > 512) state.seenIds.delete(state.seenIds.values().next().value as string);
        if (message.type === "ping") { send({ v: 1, type: "pong", id }); return; }
        if (message.type === "create" || message.type === "join") {
          if (state.roomCode) throw new Error("already_joined");
          if (!spend(request.socket.remoteAddress ?? "unknown", message.type)) throw new Error("rate_limited");
          const participant: Participant = { sessionId: message.sessionId, generation: message.generation, send, close: reason => { cleanup(); ws.close(1000, reason); } };
          const created = message.type === "create" ? manager.create() : undefined;
          const { room, resumeToken, replacedFloor } = message.type === "join"
            ? manager.join(message.roomCode, message.invitationToken, participant, message.resumeToken)
            : manager.join(created!.room.code, created!.invitationToken, participant);
          state.roomCode = room.code; state.sessionId = message.sessionId; state.participant = participant;
          send({ v: 1, type: created ? "created" : "joined", id, roomCode: room.code, ...(created ? { invitationToken: created.invitationToken } : {}), resumeToken, participantCount: room.participants.size, generation: participant.generation, iceServers: iceServers() });
          if (message.type === "join") {
            for (const peer of room.participants.values()) {
              if (peer !== participant) peer.send({ v: 1, type: "joined", roomCode: room.code, participantCount: room.participants.size, generation: peer.generation, iceServers: iceServers() });
            }
          }
          if (replacedFloor) broadcast(room, { v: 1, type: "floor_released", sessionId: replacedFloor.sessionId, leaseId: replacedFloor.leaseId, epoch: replacedFloor.epoch });
          return;
        }
        if (!state.roomCode || !state.sessionId) throw new Error("not_joined");
        const room = manager.get(state.roomCode);
        if (!room) {
          // RoomManager expiry already notified and closed both participants.
          return;
        }
        const sender = room.participants.get(state.sessionId);
        if (!sender || sender !== state.participant || sender.generation !== message.generation) throw new Error("stale_generation");
        if (message.type === "leave") { detach(state); send({ v: 1, type: "left", id, generation: message.generation }); }
        else if (message.type === "ready") manager.ready(room, sender);
        else if (message.type === "signal") {
          if (!room.negotiating || message.epoch !== room.epoch) throw new Error("stale_epoch");
          for (const peer of room.participants.values()) if (peer !== sender) peer.send({ ...message, generation: peer.generation });
        } else if (message.type === "request_floor") {
          manager.assertFloorContext(room, state.sessionId, message.generation, message.epoch);
          const expired = manager.expireFloor(room);
          if (expired) notifyFloorExpired(room, expired);
          const floor = manager.requestFloor(room, state.sessionId, message.generation, message.epoch);
          broadcast(room, { v: 1, type: "floor_granted", id, sessionId: floor.sessionId, leaseId: floor.leaseId, epoch: floor.epoch, expiresAt: floor.expiresAt, leaseDurationMs: floor.leaseDurationMs });
        } else if (message.type === "release_floor") {
          manager.assertFloorContext(room, state.sessionId, message.generation, message.epoch);
          const expired = manager.expireFloor(room);
          if (expired) notifyFloorExpired(room, expired);
          const floor = manager.releaseFloor(room, state.sessionId, message.generation, message.epoch, message.leaseId);
          if (floor) broadcast(room, { v: 1, type: "floor_released", id, sessionId: state.sessionId, leaseId: floor.leaseId, epoch: floor.epoch });
        } else if (message.type === "speaking") {
          manager.assertFloorContext(room, state.sessionId, message.generation, message.epoch);
          const expired = manager.expireFloor(room);
          if (expired) {
            notifyFloorExpired(room, expired);
            throw new Error("floor_expired");
          }
          const floor = manager.setSpeaking(room, state.sessionId, message.generation, message.epoch, message.leaseId, message.speaking);
          broadcast(room, { v: 1, type: "speaking", id, sessionId: floor.sessionId, leaseId: floor.leaseId, epoch: floor.epoch, speaking: floor.speaking });
        }
      } catch (error) { send({ v: 1, type: "error", id, generation: requestGeneration ?? state.participant?.generation, epoch: requestEpoch, code: error instanceof Error ? error.message : "invalid_message" }); }
    });
  });
  const timer = setInterval(() => {
    const now = Date.now(); pruneBudgets(now);
    for (const [ws, state] of sockets) {
      if (state.cleaned) { sockets.delete(ws); continue; }
      if (now - state.lastPongAt > heartbeatTimeoutMs) { state.cleaned = true; detach(state); sockets.delete(ws); ws.terminate(); continue; }
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, heartbeatIntervalMs);
  timer.unref();
  const expiryTimer = setInterval(() => {
    manager.expire();
    for (const { room, floor } of manager.expireFloors()) notifyFloorExpired(room, floor);
  }, Math.min(heartbeatIntervalMs, roomTtlMs, floorLeaseMs));
  expiryTimer.unref();
  let closePromise: Promise<void> | undefined;
  return { server, wss, manager,
    listen: (port = options.port ?? 8787, host = options.host ?? "127.0.0.1") => new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off("listening", bound); reject(error); };
      const bound = () => { server.off("error", failed); resolve(); };
      server.once("error", failed); server.once("listening", bound); server.listen(port, host);
    }),
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        clearInterval(timer);
        clearInterval(expiryTimer);
        for (const [ws, state] of sockets) {
          if (!state.cleaned) { state.cleaned = true; detach(state); }
          ws.terminate();
        }
        sockets.clear();
        // A graceful expiry/replacement close may still await the remote close
        // handshake after its application state has already been detached.
        for (const ws of wss.clients) ws.terminate();
        await new Promise<void>(resolve => {
          try { wss.close(() => resolve()); } catch { resolve(); }
        });
        await new Promise<void>(resolve => {
          if (!server.listening) { resolve(); return; }
          server.close(() => resolve());
        });
        server.closeIdleConnections();
      })();
      return closePromise;
    }
  };
}

function broadcast(room: { participants: Map<string, Participant> }, message: Record<string, unknown>): void {
  for (const participant of room.participants.values()) participant.send({ ...message, generation: participant.generation });
}
