// Sentry server SDK init. Runs in the Node.js runtime (the /api/* route
// handlers — /api/jobs, /api/cron/warm, etc.). This is where the CacheWarmer's
// real work happens, so it's the surface worth instrumenting: unhandled throws
// in the channel warmers, sitemap fetch, or Supabase writes surface here with a
// stack trace instead of a bare 500.
//
// Uses SENTRY_DSN (no NEXT_PUBLIC_ prefix — this service has no browser bundle).
// Inert when unset.

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  // All four TradeAero services share the single `tradeaero` Sentry project;
  // tag the service so its events separate from refactor/crawler/indexing.
  initialScope: { tags: { service: "cachewarmer" } },
});
