import { describe, expect, it, vi } from "vitest";
import { allowedOrigin, canonicalOrigin, createCloudflareTurnProvider, normalizeCloudflareIceServers, parseClientMessage } from "./index";

describe("Cloudflare signaling protocol helpers", () => {
  it("requires an exact configured origin", () => {
    expect(canonicalOrigin("https://Example.test/")).toBe("https://example.test");
    expect(allowedOrigin("https://example.test", "https://example.test")).toBe(true);
    expect(allowedOrigin("https://example.test.evil", "https://example.test")).toBe(false);
    expect(allowedOrigin("https://example.test/path", "https://example.test")).toBe(false);
  });

  it("accepts the existing create and signal wire shapes", () => {
    expect(parseClientMessage(JSON.stringify({ v: 1, id: "a", type: "create", sessionId: "s", generation: 1 }))).toEqual({ v: 1, id: "a", type: "create", sessionId: "s", generation: 1 });
    expect(parseClientMessage(JSON.stringify({ v: 1, id: "j", type: "join", roomCode: "ABC123", sessionId: "s", generation: 1 }))).toEqual({ v: 1, id: "j", type: "join", roomCode: "ABC123", sessionId: "s", generation: 1 });
    expect(parseClientMessage(JSON.stringify({ v: 1, id: "b", type: "signal", kind: "ice", payload: "candidate", generation: 1, epoch: 2 }))).toMatchObject({ type: "signal", kind: "ice", epoch: 2 });
  });

  it("requires an uppercase six-character room code and rejects invitation credentials", () => {
    for (const roomCode of ["abc123", "ABC12", "ABC1234", "ABC-12"]) expect(() => parseClientMessage(JSON.stringify({ v: 1, id: "j", type: "join", roomCode, sessionId: "s", generation: 1 }))).toThrow("invalid_message");
    expect(() => parseClientMessage(JSON.stringify({ v: 1, id: "j", type: "join", roomCode: "ABC123", invitationToken: "legacy", sessionId: "s", generation: 1 }))).toThrow("invalid_message");
  });

  it("rejects oversized and extra-field messages", () => {
    expect(() => parseClientMessage(JSON.stringify({ v: 1, id: "a", type: "ping", extra: true }))).toThrow("invalid_message");
    expect(() => parseClientMessage("x", 0)).toThrow("message_too_large");
  });

  it("normalizes Cloudflare TURN URLs and adds the required transports", () => {
    const servers = normalizeCloudflareIceServers({ iceServers: [{
      urls: [
        "stun:stun.cloudflare.com:53",
        "turn:turn.cloudflare.com:53?transport=tcp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
      ],
      username: "user",
      credential: "credential",
    }] });
    expect(servers.map(server => server.urls)).toEqual([
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turn:turn.cloudflare.com:3478?transport=udp",
    ]);
    expect(servers.every(server => !/:53(?:\?|$)/.test(server.urls))).toBe(true);
  });

  it("fetches Worker Cloudflare credentials, caches them, and falls back on errors", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key%2Fid/credentials/generate-ice-servers");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer api-token" });
      return new Response(JSON.stringify({ iceServers: [{
        urls: "turn:turn.cloudflare.com:3478?transport=tcp", username: "cf-user", credential: "cf-credential",
      }] }), { status: 200 });
    });
    const provider = createCloudflareTurnProvider({ keyId: "key/id", apiToken: "api-token", fetch: fetchImpl });
    const first = await provider.getIceServers();
    const second = await provider.getIceServers();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.map(server => server.urls)).toEqual([
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
    ]);
    expect(second).toEqual(first);

    const failed = createCloudflareTurnProvider({ keyId: "key", apiToken: "token", fetch: vi.fn(async () => new Response("no", { status: 500 })) });
    await expect(failed.getIceServers()).resolves.toEqual([]);
  });
});
