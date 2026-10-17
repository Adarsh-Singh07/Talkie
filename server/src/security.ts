import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createResumeToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashResumeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokensMatch(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashResumeToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
