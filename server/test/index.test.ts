import { describe, expect, it } from "vitest";
import { optionsFromEnvironment } from "../src/index.js";

describe("environment configuration", () => {
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
});
