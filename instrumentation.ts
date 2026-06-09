// Next.js instrumentation hook. Called once per server boot, before the first
// request. Forwards to the runtime-specific Sentry init so the SDK initialises
// the correct transport (Node vs Edge).
//
// docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation

import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Forward request-scoped errors (uncaught throws in route handlers) to Sentry so
// each handler doesn't need its own try/catch + Sentry.captureException.
export const onRequestError = Sentry.captureRequestError;
