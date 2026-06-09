import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle under .next/standalone so the Docker
  // runtime image only needs the traced node_modules subset. Skipped on
  // Vercel: its build wrapper manages output itself, and 'standalone' trips
  // Vercel's modifyConfig step (ERR_INVALID_ARG_TYPE — path is undefined).
  output: process.env.VERCEL ? undefined : 'standalone',
  // p-limit v5 and google-auth-library use Node.js-specific imports (#async_hooks,
  // node: protocol) that webpack cannot bundle. Mark them as external so Next.js
  // lets Node.js resolve them natively at runtime.
  serverExternalPackages: ['p-limit', 'google-auth-library'],
};

// withSentryConfig injects the instrumentation and (when fully configured)
// uploads source maps on deploy. Source-map upload is the most failure-prone
// step — the Sentry CLI talks to Sentry's API during the build and can stall on
// a misconfigured auth-token/org/project triple — so we only enable it when ALL
// THREE env vars are present; a half-configured state degrades to a clean no-op
// build (mirrors the hardening in TradeAero-Refactor's next.config.ts).
const sentryUploadEnabled = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  sourcemaps: {
    disable: !sentryUploadEnabled,
  },
  widenClientFileUpload: sentryUploadEnabled,
  disableLogger: true,
  automaticVercelMonitors: false,
  // Skip the release-creation API call when the triple isn't complete — the
  // release step is what hangs on a misconfigured token.
  release: sentryUploadEnabled
    ? { create: true, finalize: true }
    : { create: false, finalize: false },
  telemetry: false,
});
