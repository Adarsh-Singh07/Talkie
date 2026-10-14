import { describe, expect, it, vi } from "vitest";
import { createCloudflareTurnProvider, normalizeCloudflareIceServers } from "../src/ice.js";

describe("Cloudflare TURN credentials", () => {
  it("filters port 53, preserves supported returned entries, and caches the API response", async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key%2Fid/credentials/generate-ice-servers");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer api-token", "Content-Type": "application/json" });
      expect(init?.body).toBe(JSON.stringify({ ttl: 86400 }));
      return new Response(JSON.stringify({ iceServers: [{
        urls: [
          "stun:stun.cloudflare.com:53",
          "stun:stun.cloudflare.com:3478",
          "turn:turn.cloudflare.com:53?transport=tcp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
        ], username: "cf-user", credential: "cf-credential",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const provider = createCloudflareTurnProvider({ keyId: "key/id", apiToken: "api-token", fetch: fetchImpl, now: () => now });
    const first = await provider.getIceServers();
    const second = await provider.getIceServers();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "turn:turn.cloudflare.com:3478?transport=tcp", username: "cf-user", credential: "cf-credential" },
      { urls: "turns:turn.cloudflare.com:5349?transport=tcp", username: "cf-user", credential: "cf-credential" },
      { urls: "turn:turn.cloudflare.com:3478?transport=udp", username: "cf-user", credential: "cf-credential" },
    ]);
    expect(second).toEqual(first);
    now += 15 * 60_000;
    await provider.getIceServers();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed entries without trusting arbitrary credentials", () => {
    expect(normalizeCloudflareIceServers({ iceServers: [
      { urls: "turn:turn.cloudflare.com:3478", username: "user" },
      { urls: "turn:turn.cloudflare.com:3478", username: "user", credential: "secret" },
      { urls: "not-an-ice-url", username: "user", credential: "secret" },
    ] })).toEqual([
      { urls: "turn:turn.cloudflare.com:3478", username: "user", credential: "secret" },
      { urls: "turn:turn.cloudflare.com:3478?transport=udp", username: "user", credential: "secret" },
      { urls: "turn:turn.cloudflare.com:3478?transport=tcp", username: "user", credential: "secret" },
      { urls: "turns:turn.cloudflare.com:5349?transport=tcp", username: "user", credential: "secret" },
    ]);
  });

  it("coalesces concurrent requests and falls back to an empty result on API failure", async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((_, reject) => { rejectRequest = reject; }));
    const provider = createCloudflareTurnProvider({ keyId: "key", apiToken: "token", fetch: fetchImpl });
    const first = provider.getIceServers();
    const second = provider.getIceServers();
    rejectRequest!(new Error("network failure"));
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not cache an incomplete or unsuccessful response", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const provider = createCloudflareTurnProvider({ keyId: "key", apiToken: "token", fetch: fetchImpl });
    await expect(provider.getIceServers()).resolves.toEqual([]);
    await expect(provider.getIceServers()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
