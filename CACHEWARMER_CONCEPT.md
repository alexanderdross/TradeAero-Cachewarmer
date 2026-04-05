# TradeAero CacheWarmer — Concept & Architecture

## 1. Overview

**TradeAero CacheWarmer** is a self-hosted Node.js microservice that takes XML sitemaps and systematically warms all contained URLs across:

- **CDN / Edge caches** — direct HTTP GET via Puppeteer to populate Cloudflare and Vercel edge caches
- **Social media scraper caches** — Facebook, LinkedIn, Twitter/X, Pinterest preview cards
- **Search engines** — Google Indexing API (`URL_UPDATED` notifications), Bing Webmaster API, IndexNow protocol

The service runs before TradeAero-Indexing: once a warming job completes successfully, it automatically dispatches the `index-listings.yml` GitHub Actions workflow in TradeAero-Indexing, ensuring CDN and social media caches are warm before Googlebot and Bing crawl the URLs.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   TradeAero CacheWarmer                  │
│                                                          │
│  HTTP API (X-API-Key auth)                               │
│  POST /jobs   GET /jobs/:id   GET /runs   DELETE /cache  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │              BullMQ Job Queue (Redis)            │   │
│  │                                                  │   │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │   │
│  │  │  CDN     │  │  Social   │  │  Search      │  │   │
│  │  │  Worker  │  │  Workers  │  │  Engine      │  │   │
│  │  │          │  │           │  │  Workers     │  │   │
│  │  │ • CF     │  │ • FB OG   │  │ • Google     │  │   │
│  │  │ • Vercel │  │ • LinkedIn│  │ • Bing       │  │   │
│  │  │ • Puppet.│  │ • Twitter │  │ • IndexNow   │  │   │
│  │  │          │  │ • Pinterest│  │             │  │   │
│  │  └──────────┘  └───────────┘  └──────────────┘  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  Post-run: GitHub API → workflow_dispatch → Indexing     │
└─────────────────────────────────────────────────────────┘
```

**Technology stack:**
- Node.js 20+, TypeScript 5
- [BullMQ](https://docs.bullmq.io/) — Redis-backed job queue with retry, concurrency control
- [Puppeteer](https://purl.pt/29115/1/) — headless Chromium for full-page CDN warming
- [Pino](https://getpino.io/) — structured JSON logging
- [p-limit](https://github.com/sindresorhus/p-limit) / token bucket — per-service rate limiting
- Redis — BullMQ job state

---

## 3. Warming Targets

| Target | Method | Effect |
|--------|--------|--------|
| CDN / Edge | HTTP GET via Puppeteer | Populates Cloudflare / Vercel edge cache |
| Cloudflare | Cache Purge API + HTTP GET | Purge stale entry → re-warm |
| Vercel Edge | Purge API + HTTP GET | Purge stale entry → re-warm |
| Facebook OG | Graph API `/scrape` endpoint | Refreshes Open Graph tag cache |
| LinkedIn | Post Inspector (cookie-auth) | Refreshes link preview card |
| Twitter / X | oEmbed endpoint (Bearer token optional) | Triggers Twitterbot re-scrape of twitter:card meta tags |
| Pinterest | oEmbed API v5 (App access token) | Triggers Pinterest re-scrape of OG/card meta tags |
| Google | Indexing API (`URL_UPDATED`) | Notifies Googlebot of content change |
| Bing | Bing Webmaster API + IndexNow | Notifies Bing + Yandex + Seznam + Naver |

---

## 4. API Credentials & Setup

### 4.1 Facebook (Graph API)

**Purpose:** Refresh the Facebook Open Graph scraper cache for a URL.

**Setup:**
1. Go to [developers.facebook.com](https://developers.facebook.com) and create a new **Business** app (App type: Business).
2. In the app dashboard, note your **App ID** (shown at the top).
3. Go to **Settings → Basic** and reveal your **App Secret**.
4. Access token: composed automatically as `{appId}|{appSecret}` (App Access Token). No app review or publication required.
5. API endpoint: `POST https://graph.facebook.com/?id={url}&scrape=true&access_token={appId}|{appSecret}`

**Rate limits:**

| Limit | Value |
|-------|-------|
| Calls per hour per App | 200 |
| Recommended rate | ≤ 10 calls/second (conservative) |

---

### 4.2 LinkedIn (Post Inspector)

**Purpose:** Refresh LinkedIn's link preview cache for a URL.

**Setup:**
1. Log in to [linkedin.com](https://www.linkedin.com) in your browser.
2. Open **DevTools → Application → Cookies → linkedin.com**.
3. Copy the value of the `li_at` cookie.
4. Store in `config.local.yaml` as `linkedin.sessionCookie`.

**Rate limits:**

| Limit | Value |
|-------|-------|
| Official rate limit | None published |
| Recommended concurrency | 1 (sequential) |
| Recommended delay | ≥ 5,000 ms between requests |

> **Security warning:** The `li_at` cookie grants full access to the linked LinkedIn account. Never commit it to git. The cookie expires after approximately 1 year and must be refreshed manually.

---

### 4.3 Google (Indexing API)

**Purpose:** Notify Googlebot that a URL's content has been updated.

**Setup:**
1. In [Google Cloud Console](https://console.cloud.google.com), go to **APIs & Services → Library** and enable the **Web Search Indexing API**.
2. Go to **IAM & Admin → Service Accounts** and create a new Service Account (no roles needed at project level).
3. Open the service account → **Keys → Add Key → JSON**. Download the key file.
4. In [Google Search Console](https://search.google.com/search-console), go to **Settings → Users and Permissions** and add the service account email as an **Owner**.
5. Store the JSON key content in `config.local.yaml` as `google.serviceAccountKeyFile` path, or paste into the admin GUI.

**Rate limits:**

| Limit | Value |
|-------|-------|
| URL notifications per day | 200 per Search Console property |
| Requests per second | 600 (rarely hit) |

> **Quota note:** TradeAero-Indexing also uses the Google Indexing API (env var `GOOGLE_SERVICE_ACCOUNT_JSON`). Both services share the same 200 URL/day quota. If TradeAero-Indexing already handles your search indexing, disable this channel in CacheWarmer to avoid quota conflicts.

---

### 4.4 Bing (Webmaster API)

**Purpose:** Submit URLs directly to Bing for crawling via the Bing Webmaster API.

**Setup:**
1. Go to [bing.com/webmasters](https://www.bing.com/webmasters) and verify your website.
2. Go to **Settings (gear icon) → API Access** and click **Generate API Key**.
3. Copy the generated key. It is associated with your Microsoft account, not a specific site.
4. Add the key to `config.local.yaml` as `bing.apiKey`.

**Rate limits:**

| Limit | Value |
|-------|-------|
| URLs per day | 10,000 (default; extendable on request) |

> Works alongside IndexNow — both can run in parallel without conflict.

---

### 4.5 IndexNow

**Purpose:** Notify Bing, Yandex, Seznam, and Naver of URL updates in a single batch request.

**Setup:**
1. Generate a random key: `openssl rand -hex 16` (minimum 8 alphanumeric characters).
2. Create a text file named `{key}.txt` in the website root (e.g., `public/{key}.txt` in Next.js) containing only the key string on a single line.
3. Add the key and its hosted URL to `config.local.yaml` as `indexNow.key` and `indexNow.keyLocation`.
4. Test: `curl https://trade.aero/{key}.txt` should return the key string.

**Rate limits:**

| Limit | Value |
|-------|-------|
| URLs per batch request | Up to 10,000 |
| Official rate limit | None published |
| Partners notified per submission | Bing, Yandex, Seznam, Naver |

> **Overlap note:** TradeAero-Indexing also submits to IndexNow (env var `INDEXNOW_API_KEY`). The same key can be reused here — duplicate submissions are idempotent.

---

### 4.6 Cloudflare (Cache Purge API)

**Purpose:** Purge stale cached content from Cloudflare's edge network before re-warming.

**Setup:**
1. In [Cloudflare Dashboard](https://dash.cloudflare.com), go to **My Profile → API Tokens → Create Token**.
2. Use **Custom Token** with permission: **Zone → Cache Purge → Purge** only (no other rights needed).
3. Select the specific zone (domain) to scope the token.
4. Copy the token and your **Zone ID** (found in the domain overview sidebar under "API").
5. Add to `config.local.yaml` as `cloudflare.apiToken` and `cloudflare.zoneId`.

**Rate limits:**

| Limit | Value |
|-------|-------|
| URLs per purge request | 30 (batched automatically) |
| Propagation time | A few seconds across global PoPs |

---

### 4.7 Vercel (Edge Cache Purge)

**Purpose:** Purge stale content from Vercel's Edge Network before re-warming.

**Setup:**
1. In [Vercel Dashboard](https://vercel.com/account/tokens), go to **Settings → Tokens** and create a new token.
2. If using a team account, note your **Team ID** (starts with `team_`; optional for personal accounts).
3. Add to `config.local.yaml` as `vercel.apiToken` and optionally `vercel.teamId`.

---

### 4.8 Twitter / X (oEmbed Endpoint)

**Purpose:** Trigger Twitterbot to re-scrape `twitter:card` meta tags on the target page, refreshing how URLs appear when shared on X/Twitter.

**Mechanism:** `GET https://publish.twitter.com/oembed?url={encodedUrl}` causes Twitter's scraper to re-fetch the page. This is a public endpoint — no API key is required — but including a Bearer token improves reliability.

**Setup:**
1. Go to [developer.twitter.com](https://developer.twitter.com) → **Projects & Apps → Create App**.
2. Under **App Settings → Keys and Tokens**, click **Bearer Token → Generate**.
3. Copy the Bearer token and add to `config.local.yaml` as `twitter.bearerToken`.
4. Free-tier developer app is sufficient — no Elevated access required.

> The Bearer token does not expire unless explicitly revoked.

**Rate limits:**

| Limit | Value |
|-------|-------|
| Official rate limit | None published for oEmbed |
| Recommended delay | ≥ 2,000 ms between requests (~30/min) |

**Config:**
```yaml
twitter:
  enabled: true
  bearerToken: "AAAA…"
  delayBetweenRequests: 2000
```

---

### 4.9 Pinterest (oEmbed API v5)

**Purpose:** Trigger Pinterest to re-scrape OG and `twitter:card` meta tags on the target page, refreshing how URLs appear as Pins.

**Mechanism:** `GET https://api.pinterest.com/v5/oembed/?url={encodedUrl}&access_token={token}` causes Pinterest's scraper to re-fetch the page. This is more reliable than the public widget endpoint (`widgets.pinterest.com/v1/urls/count.json`) which only looks up existing pin counts.

**Setup:**
1. Go to [developers.pinterest.com](https://developers.pinterest.com) → **My Apps → Create App**.
2. Add `pins:read` scope (minimum required). No app review required for oEmbed access.
3. Under **Access tokens**, generate a user access token. Enable `offline_access` scope for a non-expiring token.
4. Verify your website domain in [Pinterest Business Hub](https://business.pinterest.com) to improve scrape success rates.
5. Copy the access token and add to `config.local.yaml` as `pinterest.accessToken`.

**Rate limits:**

| Limit | Value |
|-------|-------|
| Requests per hour per token | 1,000 |
| Recommended delay | ≥ 3,600 ms between requests |
| Max URLs per warming run | 900 (stay under hourly cap) |

**Config:**
```yaml
pinterest:
  enabled: true
  accessToken: "pina_…"
  delayBetweenRequests: 3600
```

---

## 5. Service Architecture

### One Worker Per Target

Each warming target runs as an independent **BullMQ worker**:

```
workers/
├── cdnWorker.ts        — HTTP GET via Puppeteer (CDN warming)
├── cloudflareWorker.ts — Cache Purge API + re-warm
├── vercelWorker.ts     — Edge Purge API + re-warm
├── facebookWorker.ts   — Graph API /scrape
├── linkedinWorker.ts   — Post Inspector (cookie-auth)
├── twitterWorker.ts    — oEmbed endpoint (Twitterbot re-scrape)
├── pinterestWorker.ts  — oEmbed API v5 (Pinterest re-scrape)
├── googleWorker.ts     — Indexing API (URL_UPDATED)
└── bingWorker.ts       — Webmaster API + IndexNow
```

### Per-Worker Behaviour

Each worker:
1. Pulls URL batches from its dedicated BullMQ queue
2. Respects per-service rate limits via `p-limit` (concurrency) + token bucket (rate/sec)
3. Logs success/failure per URL with Pino (structured JSON: `{ url, channel, status, durationMs, responseCode }`)
4. Updates job state in Redis (`done` / `failed` / `retrying`)
5. Retries failed URLs up to **3 times** with exponential backoff (base: 5s, max: 2 min)
6. Single URL failures **do not abort** the job — logs the error and continues

### Job Flow

```
POST /jobs { sitemapUrl: "https://trade.aero/sitemap.xml" }
    │
    ▼
1. Parse sitemap XML → extract URLs
2. For each enabled channel, enqueue URL batches in BullMQ
3. Workers process in parallel (respecting concurrency limits)
4. All queues drain → job marked complete
5. If triggerIndexingAfterWarming = true AND indexing_enabled = true:
   → POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches
```

---

## 6. Database / State

### Redis (BullMQ)

- Job queue, worker state, retry counters
- Required: Redis 6+ (Docker recommended)

### Supabase (Optional — Run History)

Table: **`cachewarmer_runs`**

```sql
CREATE TABLE cachewarmer_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         text NOT NULL,
  sitemap_url    text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  urls_total     int DEFAULT 0,
  urls_success   int DEFAULT 0,
  urls_failed    int DEFAULT 0,
  triggered_by   text,           -- 'cron' | 'manual' | 'api'
  status         text DEFAULT 'running',  -- 'running' | 'done' | 'failed'
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

### Supabase (Admin Config)

The **TradeAero-Refactor admin dashboard** stores service credentials in two tables:

**`system_settings`** — Global feature flags:
```sql
-- key: 'cachewarmer_enabled' | 'indexing_enabled'
-- value: true | false (jsonb)
```

**`cachewarmer_config`** — Per-service credentials:
```sql
-- service: 'facebook' | 'linkedin' | 'google' | 'bing' | 'indexnow'
--          'cloudflare' | 'vercel' | 'orchestration'
-- config: jsonb (service-specific fields)
-- enabled: boolean
```

---

## 7. HTTP API

All endpoints require `X-API-Key: {server.apiKey}` header.

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| `POST` | `/jobs` | `{ sitemapUrl?: string; urls?: string[] }` | `{ jobId: string }` |
| `GET` | `/jobs/:id` | — | `{ jobId, status, progress, urls, channels }` |
| `GET` | `/runs` | `?page=1&limit=20` | `{ runs: CacheWarmerRun[], total: number }` |
| `DELETE` | `/cache` | `{ urls: string[] }` | `{ purged: number }` |

**`POST /jobs` body:**
- `sitemapUrl`: XML sitemap URL to parse and enqueue all URLs
- `urls`: explicit list of URLs to warm (alternative to sitemap)
- One of `sitemapUrl` or `urls` is required

---

## 8. Authentication

All HTTP endpoints are protected by a static API key:

```
X-API-Key: {server.apiKey}
```

The key is configured via `server.apiKey` in `config.local.yaml`. Requests without a valid key receive `401 Unauthorized`.

---

## 9. Configuration

Two config files, merged at startup (`config.local.yaml` values override `config.yaml`):

- **`config.yaml`** — Committed to git, no secrets (structure + defaults only)
- **`config.local.yaml`** — Gitignored, holds real credentials

Full annotated `config.yaml` example:

```yaml
server:
  port: 3001
  apiKey: "CHANGE_ME"

orchestration:
  # Set to true to trigger TradeAero-Indexing after every successful warm run.
  # Requires a GitHub PAT with `workflow` scope on the TradeAero-Indexing repo.
  triggerIndexingAfterWarming: true
  githubPat: "DEIN_GITHUB_PAT"
  githubOwner: "alexanderdross"
  githubRepo: "TradeAero-Indexing"
  githubWorkflow: "index-listings.yml"
  githubRef: "main"

facebook:
  enabled: true
  appId: "DEINE_FACEBOOK_APP_ID"
  appSecret: "DEIN_FACEBOOK_APP_SECRET"
  rateLimitPerSecond: 10

linkedin:
  enabled: true
  sessionCookie: "DEIN_LI_AT_COOKIE"
  concurrency: 1
  delayBetweenRequests: 5000   # ms

google:
  enabled: true
  serviceAccountKeyFile: "./credentials/google-sa-key.json"
  dailyQuota: 200

bing:
  enabled: true
  apiKey: "DEIN_BING_API_KEY"
  dailyQuota: 10000

indexNow:
  enabled: true
  key: "DEIN_INDEXNOW_KEY"
  keyLocation: "https://www.trade.aero/DEIN_INDEXNOW_KEY.txt"

cloudflare:
  enabled: true
  apiToken: "DEIN_CLOUDFLARE_API_TOKEN"
  zoneId: "DEINE_ZONE_ID"

vercel:
  enabled: false
  apiToken: "DEIN_VERCEL_API_TOKEN"
  teamId: ""   # only needed for team accounts (starts with team_)

twitter:
  enabled: true
  bearerToken: "DEIN_TWITTER_BEARER_TOKEN"
  delayBetweenRequests: 2000

pinterest:
  enabled: true
  accessToken: "DEIN_PINTEREST_ACCESS_TOKEN"
  delayBetweenRequests: 3600

redis:
  host: "localhost"
  port: 6379

logging:
  level: "info"   # debug | info | warn | error
```

---

## 10. Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 20+ | LTS recommended |
| pnpm | 10.29+ | Package manager |
| Redis | 6+ | BullMQ job queue backend |
| Chromium | Latest | Puppeteer auto-installs; or use system Chromium via `PUPPETEER_EXECUTABLE_PATH` |

---

## 11. Key Design Principles

1. **Rate-limiting is critical** — Every worker enforces per-service rate limits. Exceeding limits (especially Facebook 200/hr, Google 200/day) triggers bans or quota exhaustion.

2. **Fault tolerance** — A single URL failure must not abort the entire job. Workers catch all errors per URL, log them, and continue. The overall job succeeds even if some URLs fail.

3. **Idempotency** — Re-warming the same URLs at any time causes no harm. Duplicate Facebook scrape calls or IndexNow submissions are safe.

4. **Security** — API key auth on all endpoints. Credentials are never committed to git (`config.local.yaml` and `credentials/` are in `.gitignore`). Input validation at all boundaries (URL format, sitemap size limits).

5. **Structured logging** — Pino with configurable log levels. Every URL operation emits `{ url, channel, status, durationMs, responseCode, error? }`.

6. **Sequential execution** — CacheWarmer is designed to run **before** TradeAero-Indexing. When warming completes, it dispatches the indexing workflow via GitHub API, ensuring edge caches are populated before Googlebot crawls.

---

## 12. Deployment

### Docker Compose

```yaml
version: "3.9"
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data

  cachewarmer:
    build: .
    restart: unless-stopped
    environment:
      - NODE_ENV=production
    volumes:
      - ./config.local.yaml:/app/config.local.yaml:ro
      - ./credentials:/app/credentials:ro
    ports:
      - "3001:3001"
    depends_on:
      - redis

volumes:
  redis-data:
```

**Gitignored files** (add to `.gitignore`):
```
config.local.yaml
credentials/
```

---

## 13. Admin GUI Integration

The **TradeAero-Refactor admin dashboard** (`dashboard/admin/#cachewarmer`) provides a credential management GUI for all CacheWarmer services. Credentials are stored encrypted in the `cachewarmer_config` Supabase table (service role access only).

**Admin GUI features:**
- **Service Control card** — Global master enable/disable toggle for the entire CacheWarmer service (`system_settings.cachewarmer_enabled`)
- **Orchestration card** — "Trigger Indexing After Warming" toggle + GitHub PAT field for the sequential execution flow
- **Per-service cards** — Enable/disable toggle + credential fields for all 7 warming targets
- Secrets are masked (`••••••••`) on load; submitting the mask sentinel leaves the existing DB value unchanged
- Changes take effect on the next warming job (microservice polls or reads config on job start)

---

## 14. Sequential Execution with TradeAero-Indexing

CacheWarmer and TradeAero-Indexing run **in sequence**:

```
CacheWarmer runs first
    └── Job completes successfully
        └── orchestration.triggerIndexingAfterWarming = true?
            └── system_settings.indexing_enabled = true?
                └── POST GitHub API → workflow_dispatch → index-listings.yml
                    └── TradeAero-Indexing runs
```

**Rationale:** Warming CDN and social media caches before search engine crawling ensures:
- Googlebot and Bingbot get fast responses (cached at edge)
- OG metadata is fresh in Facebook/LinkedIn when users share newly indexed pages
- No "cold cache" penalty during the critical first crawl window

**Enable/disable matrix:**

| `cachewarmer_enabled` | `indexing_enabled` | `triggerIndexingAfterWarming` | Outcome |
|---|---|---|---|
| `false` | any | any | CacheWarmer exits immediately; no warming, no indexing trigger |
| `true` | `false` | `true` | CacheWarmer runs; Indexing trigger skipped |
| `true` | `true` | `false` | CacheWarmer runs; Indexing trigger skipped |
| `true` | `true` | `true` | Full sequential flow — warming then indexing |

The **existing 15-minute cron** on `index-listings.yml` in GitHub Actions remains as a fallback. Operators can disable it in GitHub if they fully switch to CacheWarmer-triggered execution.
