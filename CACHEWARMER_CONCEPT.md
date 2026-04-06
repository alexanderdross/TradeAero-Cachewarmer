# TradeAero CacheWarmer — Architecture & Operations Guide

## 1. Overview

**TradeAero CacheWarmer** is a Next.js microservice deployed on Vercel that reads XML sitemaps and systematically warms URLs across CDN, social media scraper caches, and search engine submission APIs.

After a successful warm run the service optionally dispatches the `index-listings.yml` GitHub Actions workflow in **TradeAero-Indexing**, ensuring CDN and social caches are populated before Googlebot crawls.

**Live deployment:** `https://trade-aero-cachewarmer.vercel.app`
**Admin GUI:** `https://refactor.trade.aero/dashboard/admin/#cachewarmer`

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│              TradeAero CacheWarmer (Vercel)              │
│                                                          │
│  GET  /api/health          — liveness probe              │
│  POST /api/jobs            — submit warm job (sync)      │
│  GET  /api/jobs            — list run history            │
│  GET  /api/cron/warm       — Vercel Cron trigger         │
│  POST /api/admin/trigger   — fire-and-forget trigger     │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │         runAllChannels() — parallel execution    │   │
│  │                                                  │   │
│  │  CDN    CF    Vercel  FB    LinkedIn  Twitter     │   │
│  │  Pinterest  Google  Bing  IndexNow               │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  Post-run: GitHub API → workflow_dispatch → Indexing     │
└─────────────────────────────────────────────────────────┘
         ▲                          ▲
         │ x-api-key                │ CRON_SECRET Bearer
   GitHub Actions             Vercel Cron
   (manual trigger)           (scheduled)
         ▲
   Admin Dashboard
   (Trigger Now button)
```

**Technology stack:**
- Next.js 15, TypeScript, deployed on Vercel
- Axios for all HTTP channel calls
- Supabase (PostgreSQL) for run history and admin config storage
- No Redis, no BullMQ, no Puppeteer — lightweight synchronous execution

---

## 3. Warming Channels

| Channel | Method | What it does |
|---------|--------|--------------|
| CDN | HTTP GET | Populates Vercel/Cloudflare edge cache |
| Cloudflare | Cache Purge API + GET | Purges stale entry → re-warms |
| Vercel Edge | Purge API + GET | Purges stale entry → re-warms |
| Facebook | Graph API `/scrape` | Refreshes Open Graph tag cache |
| LinkedIn | Post Inspector (cookie) | Refreshes link preview card |
| Twitter / X | oEmbed (Bearer optional) | Triggers Twitterbot re-scrape |
| Pinterest | oEmbed API v5 (token optional) | Triggers Pinterest re-scrape |
| Google | Indexing API `URL_UPDATED` | Notifies Googlebot of content change |
| Bing | Webmaster API | Submits URLs directly to Bing |
| IndexNow | IndexNow protocol | Notifies Bing, Yandex, Seznam, Naver |

All channels are **independent** — a failure in one channel does not abort others. Results are recorded per-channel in the run history.

---

## 4. Triggering a Warm Run

### 4.1 Admin Dashboard — Trigger Now

The **Trigger Now** button in the Cache Warmer admin tab calls:

```
POST /api/admin/cachewarmer/trigger   (TradeAero-Refactor, admin-authed)
  └─▶ POST /api/admin/trigger          (CacheWarmer, x-api-key authed)
        └─▶ fire-and-forget GET /api/cron/warm   (CRON_SECRET authed)
```

Returns immediately (`{ triggered: true }`). The warm job runs as an independent Vercel function invocation. Results appear in Run History after a few minutes.

### 4.2 GitHub Actions — Manual Workflow

`warm-cache.yml` triggers `POST /api/jobs` directly with `x-api-key` auth. This runs synchronously (up to 5 min Vercel function limit). Useful for on-demand runs from GitHub UI.

**Required GitHub configuration:**
- **Secret** `CACHEWARMER_API_KEY` — must match the `CACHEWARMER_API_KEY` env var in Vercel
- **Variable** `CACHEWARMER_URL` = `https://trade-aero-cachewarmer.vercel.app`

### 4.3 Vercel Cron — Scheduled

Defined in `vercel.json`. Runs `GET /api/cron/warm` automatically on the configured schedule. Authenticated via `CRON_SECRET` Bearer token.

---

## 5. HTTP API

All endpoints (except `/api/health` and `/api/cron/warm`) require `x-api-key` header.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/health` | None | Liveness probe — returns `{ ok: true }` |
| `POST` | `/api/jobs` | `x-api-key` | Submit and run a full warm job (synchronous) |
| `GET` | `/api/jobs` | `x-api-key` | List run history (paginated) |
| `GET` | `/api/cron/warm` | `CRON_SECRET` Bearer | Cron/trigger endpoint |
| `POST` | `/api/admin/trigger` | `x-api-key` | Fire-and-forget warm trigger |

**`POST /api/jobs` body (optional):**
```json
{ "sitemapUrl": "https://refactor.trade.aero/2d6a9a/sitemap.xml" }
```
If omitted, uses `SITEMAP_URL` env var.

---

## 6. Environment Variables

Set in Vercel → trade-aero-cachewarmer → Environment Variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CACHEWARMER_API_KEY` | Yes | API key for `x-api-key` header auth |
| `CACHEWARMER_URL` | Yes | Self-referencing URL (used by trigger endpoint) |
| `CRON_SECRET` | Yes | Bearer token for `/api/cron/warm` |
| `SITEMAP_URL` | Yes | Default sitemap URL (currently `https://refactor.trade.aero/2d6a9a/sitemap.xml`) |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (bypasses RLS) |
| `GITHUB_PAT` | For orchestration | PAT with `workflow` scope for triggering TradeAero-Indexing |

> After launch, update `SITEMAP_URL` to `https://trade.aero/2d6a9a/sitemap.xml`.

---

## 7. Database

### `cachewarmer_runs` — Run History

```sql
CREATE TABLE cachewarmer_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          text NOT NULL,
  sitemap_url     text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  urls_total      int DEFAULT 0,
  urls_success    int DEFAULT 0,
  urls_failed     int DEFAULT 0,
  triggered_by    text,     -- 'cron' | 'manual' | 'api'
  status          text DEFAULT 'running',  -- 'running' | 'done' | 'failed'
  channel_results jsonb,    -- { facebook: { success, failed }, ... }
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

### `service_configs` — Admin-Managed Channel Config

Stored in the TradeAero-Refactor Supabase instance (same DB). The CacheWarmer reads channel config and credentials from this table on each job run.

```
service: 'facebook' | 'linkedin' | 'google' | 'bing' | 'indexnow'
         'cloudflare' | 'vercel' | 'twitter' | 'pinterest' | 'orchestration'
config:  jsonb  (service-specific credentials)
enabled: boolean
```

### `system_settings` — Global Feature Flags

```
key: 'cachewarmer_enabled' | 'indexing_enabled'
value: true | false (jsonb)
```

---

## 8. Channel Setup Guides

### 8.1 Facebook (Graph API)

1. [developers.facebook.com](https://developers.facebook.com) → Create **Business** app
2. Note **App ID** and reveal **App Secret** (Settings → Basic)
3. Access token = `{appId}|{appSecret}` (auto-composed, no review needed)

Rate limit: 200 calls/hour per App. Recommended delay: ≥ 500 ms.

---

### 8.2 LinkedIn (Post Inspector)

1. Log in to linkedin.com → DevTools → Application → Cookies → `li_at`
2. Copy the cookie value

> Cookie expires after ~1 year. Refresh manually when LinkedIn sessions expire.
> Security: the `li_at` cookie grants full account access — never commit to git.

---

### 8.3 Google (Indexing API)

1. [Google Cloud Console](https://console.cloud.google.com) → Enable **Web Search Indexing API**
2. IAM → Service Accounts → Create → Keys → JSON → Download
3. [Search Console](https://search.google.com/search-console) → Settings → Users → Add service account as **Owner**
4. Paste JSON key content into admin dashboard

Rate limit: 200 URL notifications/day per Search Console property.

> TradeAero-Indexing also uses this API. Both share the 200/day quota. Disable one if quota is tight.

---

### 8.4 Bing (Webmaster API)

1. [bing.com/webmasters](https://www.bing.com/webmasters) → Verify site
2. Settings → API Access → Generate API Key

Rate limit: 10,000 URLs/day.

---

### 8.5 IndexNow

1. Generate key: `openssl rand -hex 16`
2. Create `public/{key}.txt` in Next.js with the key as content
3. Enter key in admin dashboard

Partners notified per submission: Bing, Yandex, Seznam, Naver.

> TradeAero-Indexing also submits IndexNow. Same key can be reused — duplicate submissions are idempotent.

---

### 8.6 Cloudflare (Cache Purge API)

1. Cloudflare Dashboard → My Profile → API Tokens → Create Token
2. Permission: **Zone → Cache Purge → Purge** only
3. Note **Zone ID** from domain overview sidebar

---

### 8.7 Vercel (Edge Cache Purge)

1. [vercel.com/account/tokens](https://vercel.com/account/tokens) → Create token
2. Optional: note Team ID (starts with `team_`) for team accounts

---

### 8.8 Twitter / X (oEmbed)

**Mechanism:** `GET https://publish.twitter.com/oembed?url={encodedUrl}` — triggers Twitterbot re-scrape. Public endpoint, no key required. Bearer token improves reliability.

1. [developer.twitter.com](https://developer.twitter.com) → Projects & Apps → Create App
2. Keys and Tokens → Bearer Token → Generate
3. Paste into admin dashboard (optional)

Rate limit: none published. Recommended delay ≥ 2,000 ms.

---

### 8.9 Pinterest (oEmbed API v5)

**Mechanism:** `GET https://api.pinterest.com/v5/oembed/?url={encodedUrl}` — triggers Pinterest re-scrape. **Access token is optional** — the public endpoint works without authentication (lower reliability).

**To get an access token (optional but recommended):**
1. [developers.pinterest.com](https://developers.pinterest.com) → My Apps → use the **Trade:Aero** app (App ID: 1559400, Trial access active)
2. Under **Redirect URIs**, add `https://trade.aero`
3. Click **Generate token** — scopes: `pins:read`, `boards:read`, `user_accounts:read`
4. Paste the `pina_…` token into admin dashboard

Rate limit with token: 1,000 req/hour. Without token: no hard limit.

> When Pinterest Standard access is approved, request `pins:write` scope to enable auto-publishing premium listings as Pins.

---

## 9. Sitemap Handling

The sitemap fetcher automatically handles:
- **Sitemap indexes** (recursive child sitemap resolution)
- **Domain mismatch** — if a sitemap index at `refactor.trade.aero` lists child sitemaps pointing to `trade.aero` (pre-launch), child URLs are automatically rewritten to use the index's domain
- **Failed child sitemaps** — skipped with a warning, warming continues with resolved URLs

> After launch, update `SITEMAP_URL` in Vercel CacheWarmer env vars from `refactor.trade.aero` to `trade.aero` and redeploy.

---

## 10. Admin Dashboard

**URL:** `https://refactor.trade.aero/dashboard/admin/#cachewarmer`

**Cards (top to bottom):**

| Card | Purpose |
|------|---------|
| **Cache Warming** | Global enable/disable toggle + **Trigger Now** button |
| **Execution Order** | Toggle to auto-trigger TradeAero-Indexing after each warm run |
| **Run History** | Last 30 days stats + per-run list with channel results |
| **Facebook** | App ID + App Secret |
| **LinkedIn** | `li_at` session cookie |
| **Google** | Service Account JSON |
| **Bing** | API Key |
| **IndexNow** | Key + key file location |
| **Cloudflare** | API Token + Zone ID |
| **Vercel** | API Token + Team ID |
| **Twitter / X** | Bearer Token (optional) |
| **Pinterest** | Access Token (optional) |

Secrets are masked on load (`••••••••`). Submitting a masked value leaves the existing credential unchanged.

---

## 11. Sequential Execution with TradeAero-Indexing

```
Warm run completes
    └── orchestration enabled?
        └── system_settings.indexing_enabled = true?
            └── POST GitHub API → workflow_dispatch → index-listings.yml
                └── TradeAero-Indexing runs
```

| `cachewarmer_enabled` | `indexing_enabled` | Orchestration toggle | Outcome |
|---|---|---|---|
| `false` | any | any | No warming, no indexing trigger |
| `true` | `false` | `true` | Warming runs; indexing skipped |
| `true` | `true` | `false` | Warming runs; indexing skipped |
| `true` | `true` | `true` | Full sequential flow |

---

## 12. Pending / Future Work

| Item | Status |
|------|--------|
| Facebook/Instagram OG scraper | Blocked — Meta business verification required |
| Pinterest `pins:write` (auto-publish premium listings) | Pending Standard access upgrade |
| Cloudflare | Enabled but not yet configured (needs API Token + Zone ID) |
| `SITEMAP_URL` post-launch update | Update to `https://trade.aero/2d6a9a/sitemap.xml` after launch |
