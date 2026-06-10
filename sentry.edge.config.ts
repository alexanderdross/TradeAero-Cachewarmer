// Sentry edge SDK init. Runs in the Vercel Edge runtime. The CacheWarmer has no
// edge routes today, but Next.js loads this whenever a request is served on the
// edge runtime, so we keep the init symmetric with the Node one. Same env vars /
// inert-when-DSN-missing semantics.

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  initialScope: { tags: { service: "cachewarmer" } },
});
