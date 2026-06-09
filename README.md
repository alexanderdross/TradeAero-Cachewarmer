# TradeAero CacheWarmer

A small Next.js 16 microservice that reads XML sitemaps and systematically
warms URLs across CDN edge caches, social-media scraper caches, and search
engine submission APIs. It runs on Vercel (cron-triggered) and can also be
driven on demand through its HTTP API.

See [`CACHEWARMER_CONCEPT.md`](./CACHEWARMER_CONCEPT.md) for the full design.

## Purpose

When a page on `trade.aero` is published or changed, its cached
representations across CDNs, social scrapers (Facebook/LinkedIn/etc.) and
search indexes can be stale. The CacheWarmer fetches each URL and pings the
relevant channel APIs so those caches refresh proactively. It also runs an
optional warn-only schema.org JSON-LD validator over the same URL set.

There is **no Redis or external queue** — concurrency is bounded in-process
with `p-limit`, and run history is persisted in Supabase.

## API

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | none | Liveness probe |
| `GET /api/jobs` | `x-api-key` | Paginated run history (`page`, `limit` query params, clamped) |
| `POST /api/jobs` | `x-api-key` | Trigger a warming run (`{ sitemapUrl?, urls? }`) |
| `POST /api/jobs/validate` | `x-api-key` | Run the JSON-LD validator only |
| `GET /api/jobs/[id]` | `x-api-key` | Single run detail |
| `GET /api/cron/warm` | `Bearer CRON_SECRET` | Scheduled warming run (Vercel cron) |

Caller-supplied URLs (`sitemapUrl`, `urls[]`) are restricted by a host
allowlist (SSRF hardening). Requests for hosts outside the allowlist are
rejected with `400`.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SUPABASE_URL` | yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Supabase service-role key |
| `CACHEWARMER_API_KEY` | yes | — | API key for `/api/jobs*` (fail-closed if unset) |
| `CRON_SECRET` | yes | — | Bearer secret for `/api/cron/warm` (fail-closed if unset) |
| `SITEMAP_URL` | no | `https://trade.aero/sitemap.xml` | Default sitemap |
| `WARM_ALLOWED_HOSTS` | no | `trade.aero` | Comma-separated host allowlist for outbound fetches |
| `HEARTBEAT_URL` | no | — | Dead-man's-switch (healthchecks.io / cronitor). The warm cron pings it on a healthy tick and `<url>/fail` when it had to reap stranded `running` runs. No-op when unset; the URL itself is the credential. |
| `SENTRY_DSN` | no | — | Sentry DSN for server-side error + performance reporting (route handlers). Inert when unset. |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | no | — | Build-time only. Enable Sentry source-map upload + release creation on deploy. Upload is gated on **all three** being set — a partial config degrades to a clean no-op build (avoids the CLI stall). |

Channel credentials and feature flags are stored in Supabase
(`cachewarmer_config`, `system_settings`) rather than env vars.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Local dev server on port 3001 |
| `npm run build` | Production build (`next build`) |
| `npm run start` | Run the production build on port 3001 |
| `npm run lint` | ESLint over `src` |
| `npm run type-check` | `tsc --noEmit` |
| `npm test` | Run the vitest suite |
| `npm run test:watch` | Vitest in watch mode |

Coverage is available via `npx vitest run --coverage` (v8 provider).

## Deploy model

- **Primary:** deployed on Vercel. `vercel.json` schedules
  `GET /api/cron/warm` once daily (`0 5 * * *`) as a *backstop* only —
  real-time warming is event-driven: the Refactor publish/retranslate
  pipelines POST the specific changed URLs to `/api/jobs` after a listing
  is translated, so the daily cron just sweeps up anything missed.
- **Container:** the `Dockerfile` builds a Next.js standalone image
  (`output: 'standalone'`) and `docker-compose.yml` runs the single
  `cachewarmer` service on port 3001. No other services are required.
