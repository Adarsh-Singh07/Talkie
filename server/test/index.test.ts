import { describe, expect, it } from "vitest";
import { optionsFromEnvironment } from "../src/index.js";

describe("environment configuration", () => {
  const dynamic = { TURN_URL: "turn:relay.example:3478?transport=udp", TURN_SHARED_SECRET: "test-only-placeholder-not-a-real-secret" };
  it("requires an explicit origin allowlist in production", () => {
    expect(() => optionsFromEnvironment({ NODE_ENV: "production" })).toThrow(/ALLOWED_ORIGINS/);
    const options = optionsFromEnvironment({ NODE_ENV: "production", ALLOWED_ORIGINS: "https://talkie.example" });
    expect(options.allowedOrigins).toEqual(["https://talkie.example"]);
  });

  it("rejects malformed origins and incomplete TURN settings", () => {
    expect(() => optionsFromEnvironment({ ALLOWED_ORIGINS: "https://talkie.example/" })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => optionsFromEnvironment({ TURN_URL: "turn:relay.example", TURN_USERNAME: "user" })).toThrow(/TURN_URL/);
    expect(() => optionsFromEnvironment({ STUN_URL: "https://relay.example" })).toThrow(/STUN_URL/);
  });

  it("keeps bounded heartbeat and resource settings numeric", () => {
    const options = optionsFromEnvironment({
      HEARTBEAT_INTERVAL_SECONDS: "2",
      HEARTBEAT_TIMEOUT_SECONDS: "7",
      MAX_MESSAGE_BYTES: "100000",
      MAX_SOCKETS: "25",
      MAX_ROOMS: "12",
    });
    expect(options.heartbeatIntervalMs).toBe(2_000);
    expect(options.heartbeatTimeoutMs).toBe(7_000);
    expect(options.maxMessageBytes).toBe(100_000);
    expect(options.maxSockets).toBe(25);
    expect(options.maxRooms).toBe(12);
  });

  it("requires REST credentials for enabled production TURN, while keeping development static support", () => {
    const production = { NODE_ENV: "production", ALLOWED_ORIGINS: "https://talkie.example" };
    expect(() => optionsFromEnvironment({ ...production, TURN_URL: dynamic.TURN_URL })).toThrow(/TURN_SHARED_SECRET/);
    const legacy = { TURN_URL: dynamic.TURN_URL, TURN_USERNAME: "dev-user", TURN_CREDENTIAL: "dev-password" };
    expect(() => optionsFromEnvironment({ ...production, ...legacy })).toThrow(/static/);
    expect(optionsFromEnvironment(legacy).iceServers).toEqual([{ urls: legacy.TURN_URL, username: "dev-user", credential: "dev-password" }]);
    const options = optionsFromEnvironment({ ...production, ...dynamic });
    expect(options.turnRest?.ttlSeconds).toBe(3900);
    expect(options.iceServers).toEqual([]);
  });

  it("accepts multiple TURN transports with string URLs and the TTL boundary", () => {
    const urls = ["turn:relay.example:3478?transport=udp", "turn:relay.example:3478?transport=tcp", "turns:relay.example:5349?transport=tcp", "turn:[::1]:3478"];
    expect(optionsFromEnvironment({ ...dynamic, TURN_URL: urls.join(", "), TURN_CREDENTIAL_TTL_SECONDS: "3660" }).turnRest?.urls).toEqual(urls);
    expect(optionsFromEnvironment({ ...dynamic, ROOM_TTL_SECONDS: "86340", TURN_CREDENTIAL_TTL_SECONDS: "86400" }).turnRest?.ttlSeconds).toBe(86400);
    expect(optionsFromEnvironment({ ...dynamic, TURN_SHARED_SECRET: "é".repeat(16) }).turnRest).toBeDefined();
  });

  it.each([
    { TURN_SHARED_SECRET: "short" },
    { TURN_SHARED_SECRET: " ".repeat(32) },
    { TURN_SHARED_SECRET: "" },
    { TURN_USERNAME: "legacy" },
    { TURN_CREDENTIAL: "legacy" },
    { TURN_USERNAME: "" },
    { TURN_CREDENTIAL_TTL_SECONDS: "3659" },
    { TURN_CREDENTIAL_TTL_SECONDS: "86401" },
    { TURN_CREDENTIAL_TTL_SECONDS: "0" },
    { TURN_CREDENTIAL_TTL_SECONDS: "3900.5" },
    { TURN_CREDENTIAL_TTL_SECONDS: "NaN" },
    { ROOM_TTL_SECONDS: "3900" },
    { TURN_URL: "" },
    { TURN_URL: "turn:relay.example," },
    { TURN_URL: "turns:relay.example?transport=udp" },
    { TURN_URL: "https://relay.example" },
    { TURN_URL: "turn://relay.example" },
    { TURN_URL: "turn:user@relay.example" },
    { TURN_URL: "turn:relay.example:65536" },
    { TURN_URL: "turn:relay.example/path" },
    { TURN_URL: "turn:relay.example?transport=tls" },
  ])("rejects invalid dynamic TURN environment %j", invalid => {
    expect(() => optionsFromEnvironment({ ...dynamic, ...invalid })).toThrow(/TURN/);
  });

  it("rejects orphaned dynamic settings", () => {
    expect(() => optionsFromEnvironment({ TURN_SHARED_SECRET: dynamic.TURN_SHARED_SECRET })).toThrow(/TURN_URL/);
    expect(() => optionsFromEnvironment({ TURN_URL: dynamic.TURN_URL, TURN_CREDENTIAL_TTL_SECONDS: "3900" })).toThrow(/TURN_SHARED_SECRET/);
    expect(() => optionsFromEnvironment({ TURN_CREDENTIAL_TTL_SECONDS: "3900" })).toThrow(/TURN_URL/);
  });
});
