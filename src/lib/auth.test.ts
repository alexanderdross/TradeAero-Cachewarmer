import { describe, it, expect, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { verifyApiKey, verifyCronSecret } from "./auth";

// Minimal NextRequest stand-in — the helpers only read from
// request.headers.get(...), so a plain object with a get() shim is enough
// and avoids pulling the full next/server runtime into the unit test.
function makeRequest(headers: Record<string, string>): NextRequest {
  const lowercased: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowercased[k.toLowerCase()] = v;
  return {
    headers: {
      get: (name: string): string | null =>
        lowercased[name.toLowerCase()] ?? null,
    },
  } as unknown as NextRequest;
}

describe("verifyApiKey", () => {
  const original = process.env.CACHEWARMER_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.CACHEWARMER_API_KEY;
    else process.env.CACHEWARMER_API_KEY = original;
  });

  it("returns true when x-api-key matches CACHEWARMER_API_KEY", () => {
    process.env.CACHEWARMER_API_KEY = "secret-123";
    expect(verifyApiKey(makeRequest({ "x-api-key": "secret-123" }))).toBe(true);
  });

  it("returns false when x-api-key does not match", () => {
    process.env.CACHEWARMER_API_KEY = "secret-123";
    expect(verifyApiKey(makeRequest({ "x-api-key": "wrong" }))).toBe(false);
  });

  it("returns false when the header is missing", () => {
    process.env.CACHEWARMER_API_KEY = "secret-123";
    expect(verifyApiKey(makeRequest({}))).toBe(false);
  });

  it("returns false when CACHEWARMER_API_KEY is not set — fail-closed", () => {
    delete process.env.CACHEWARMER_API_KEY;
    expect(verifyApiKey(makeRequest({ "x-api-key": "anything" }))).toBe(false);
  });
});

describe("verifyCronSecret", () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("returns true when authorization is Bearer <CRON_SECRET>", () => {
    process.env.CRON_SECRET = "cron-abc";
    expect(
      verifyCronSecret(makeRequest({ authorization: "Bearer cron-abc" })),
    ).toBe(true);
  });

  it("returns false when the scheme is wrong (Basic vs Bearer)", () => {
    process.env.CRON_SECRET = "cron-abc";
    expect(
      verifyCronSecret(makeRequest({ authorization: "Basic cron-abc" })),
    ).toBe(false);
  });

  it("returns false when the token does not match the secret", () => {
    process.env.CRON_SECRET = "cron-abc";
    expect(
      verifyCronSecret(makeRequest({ authorization: "Bearer wrong" })),
    ).toBe(false);
  });

  it("returns false when CRON_SECRET is not set — fail-closed", () => {
    delete process.env.CRON_SECRET;
    expect(
      verifyCronSecret(makeRequest({ authorization: "Bearer anything" })),
    ).toBe(false);
  });
});
