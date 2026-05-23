/**
 * Hermetic smoke suite for the main route handlers.
 *
 * Exercises GET/POST /api/jobs, POST /api/jobs/validate and GET /api/health
 * with every collaborator (Supabase, axios, channels, sitemap, validation)
 * mocked. Asserts HTTP status codes, the `enabled`-flag gating (503 when the
 * service / validator is disabled) and the SSRF host-allowlist rejection.
 *
 * Kept fast and offline — no real network or DB access.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks --------------------------------------------------------------
// axios is mocked so nothing here ever hits the network even if a guard
// were to slip.
vi.mock("axios", () => ({
  default: { get: vi.fn(async () => ({ status: 200, data: "" })) },
}));

// Supabase is never reached because the lib modules below are mocked, but
// stub it anyway so an accidental import cannot throw on missing env vars.
vi.mock("@/lib/supabase", () => ({
  getSupabase: () => {
    throw new Error("supabase must not be reached in the smoke suite");
  },
}));

// Mutable config the per-test cases tweak to drive the enabled-flag gating.
const configState = {
  cachwarmerEnabled: true,
  indexingEnabled: false,
  sitemapUrl: "https://trade.aero/sitemap.xml",
  channels: {},
  orchestration: { enabled: false, config: {} },
  validation: {
    enabled: true,
    concurrency: 2,
    useRemoteValidator: false,
    fetchTimeoutMs: 1000,
  },
};

vi.mock("@/lib/config", () => ({
  loadServiceConfig: vi.fn(async () => configState),
}));

vi.mock("@/lib/runs", () => ({
  createRun: vi.fn(async () => "run-1"),
  updateRun: vi.fn(async () => {}),
  listRuns: vi.fn(async () => ({ runs: [], total: 0 })),
  persistValidationResults: vi.fn(async () => {}),
}));

vi.mock("@/lib/channels", () => ({
  runAllChannels: vi.fn(async () => ({ cdn: { success: 1, failed: 0 } })),
}));

vi.mock("@/lib/sitemap", () => ({
  fetchSitemapUrls: vi.fn(async () => ["https://trade.aero/a"]),
  fetchUrlsFromShards: vi.fn(async () => ["https://trade.aero/aircraft/x"]),
  listSitemapIndex: vi.fn(async () => [
    "https://trade.aero/sitemap-aircraft.xml",
    "https://trade.aero/sitemap-jobs.xml",
  ]),
}));

vi.mock("@/lib/validation", () => ({
  validateUrlBatch: vi.fn(async () => ({
    ok: 1,
    warningsOnly: 0,
    errors: 0,
    fetchFailed: 0,
    reports: [],
  })),
}));

vi.mock("@/lib/orchestration", () => ({
  triggerIndexing: vi.fn(async () => {}),
}));

import { GET as healthGET } from "@/app/api/health/route";
import { GET as jobsGET, POST as jobsPOST } from "@/app/api/jobs/route";
import { POST as validatePOST } from "@/app/api/jobs/validate/route";
import { GET as sectionsGET } from "@/app/api/sitemap-sections/route";

const API_KEY = "smoke-key";

function jobsRequest(
  method: "GET" | "POST",
  opts: { auth?: boolean; body?: unknown; path?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.auth !== false) headers["x-api-key"] = API_KEY;
  return new NextRequest(
    `https://warmer.local${opts.path ?? "/api/jobs"}`,
    {
      method,
      headers,
      ...(opts.body !== undefined
        ? { body: JSON.stringify(opts.body) }
        : {}),
    },
  );
}

beforeEach(() => {
  process.env.CACHEWARMER_API_KEY = API_KEY;
  configState.cachwarmerEnabled = true;
  configState.validation.enabled = true;
});

describe("GET /api/health", () => {
  it("returns 200 and an ok payload", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.service).toBe("tradeaero-cachewarmer");
  });
});

describe("GET /api/jobs", () => {
  it("401s without an API key", async () => {
    const res = await jobsGET(jobsRequest("GET", { auth: false }));
    expect(res.status).toBe(401);
  });

  it("returns 200 with runs list when authorized", async () => {
    const res = await jobsGET(jobsRequest("GET"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ runs: [], total: 0, page: 1, limit: 20 });
  });

  it("clamps out-of-range pagination params", async () => {
    const res = await jobsGET(
      jobsRequest("GET", { path: "/api/jobs?page=-5&limit=99999" }),
    );
    const json = await res.json();
    expect(json.page).toBe(1);
    expect(json.limit).toBe(100);
  });
});

describe("POST /api/jobs", () => {
  it("401s without an API key", async () => {
    const res = await jobsPOST(jobsRequest("POST", { auth: false, body: {} }));
    expect(res.status).toBe(401);
  });

  it("503s when the cache-warmer is disabled", async () => {
    configState.cachwarmerEnabled = false;
    const res = await jobsPOST(jobsRequest("POST", { body: {} }));
    expect(res.status).toBe(503);
  });

  it("400s when sitemapUrl is outside the host allowlist", async () => {
    const res = await jobsPOST(
      jobsRequest("POST", {
        body: { sitemapUrl: "http://169.254.169.254/latest/meta-data" },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400s when a url is outside the host allowlist", async () => {
    const res = await jobsPOST(
      jobsRequest("POST", { body: { urls: ["https://evil.example.com/x"] } }),
    );
    expect(res.status).toBe(400);
  });

  it("200s for an allowlisted job and reports channel results", async () => {
    const res = await jobsPOST(
      jobsRequest("POST", { body: { urls: ["https://trade.aero/page"] } }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.urlsTotal).toBe(1);
    expect(json.channelResults).toBeDefined();
  });

  it("400s when a section shard is outside the host allowlist", async () => {
    const res = await jobsPOST(
      jobsRequest("POST", {
        body: { sections: ["https://evil.example.com/sitemap-aircraft.xml"] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("200s with sections-scoped URLs (uses fetchUrlsFromShards)", async () => {
    const res = await jobsPOST(
      jobsRequest("POST", {
        body: {
          sections: ["https://trade.aero/2d6a9a/sitemap-aircraft.xml"],
        },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // The mocked fetchUrlsFromShards returns 1 URL.
    expect(json.urlsTotal).toBe(1);
  });
});

describe("POST /api/jobs/validate", () => {
  it("401s without an API key", async () => {
    const res = await validatePOST(
      jobsRequest("POST", { auth: false, body: {}, path: "/api/jobs/validate" }),
    );
    expect(res.status).toBe(401);
  });

  it("503s when validation is disabled", async () => {
    configState.validation.enabled = false;
    const res = await validatePOST(
      jobsRequest("POST", { body: {}, path: "/api/jobs/validate" }),
    );
    expect(res.status).toBe(503);
  });

  it("200s and enqueues a validation_only run", async () => {
    const res = await validatePOST(
      jobsRequest("POST", { body: {}, path: "/api/jobs/validate" }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    // The route only enqueues a run — it does NOT resolve the sitemap
    // (that would 504); the /api/cron/warm tick resolves it and does the
    // work, so there is no urlsTotal in the response.
    expect(json.queued).toBe(true);
    expect(json.runId).toBe("run-1");
  });

  it("400s when a section shard is outside the host allowlist", async () => {
    const res = await validatePOST(
      jobsRequest("POST", {
        body: { sections: ["https://evil.example.com/sitemap-x.xml"] },
        path: "/api/jobs/validate",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("200s and enqueues a sections-scoped validation_only run", async () => {
    const res = await validatePOST(
      jobsRequest("POST", {
        body: {
          sections: ["https://trade.aero/2d6a9a/sitemap-aircraft.xml"],
        },
        path: "/api/jobs/validate",
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.queued).toBe(true);
  });
});

describe("GET /api/sitemap-sections", () => {
  function sectionsRequest(auth = true): NextRequest {
    const headers: Record<string, string> = {};
    if (auth) headers["x-api-key"] = API_KEY;
    return new NextRequest("https://warmer.local/api/sitemap-sections", {
      method: "GET",
      headers,
    });
  }

  it("401s without an API key", async () => {
    const res = await sectionsGET(sectionsRequest(false));
    expect(res.status).toBe(401);
  });

  it("returns the discovered shard list with derived labels", async () => {
    const res = await sectionsGET(sectionsRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sections).toEqual([
      { url: "https://trade.aero/sitemap-aircraft.xml", label: "aircraft" },
      { url: "https://trade.aero/sitemap-jobs.xml", label: "jobs" },
    ]);
  });
});
