import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import * as Sentry from "@sentry/nextjs";

export const dynamic = "force-dynamic";

/**
 * GET /api/sentry-test
 *
 * Ops smoke test for the Sentry wiring. Captures one deliberate exception
 * (tagged service=cachewarmer via the shared sentry.server.config.ts init) and
 * returns the Sentry event id, so we can confirm the DSN + SDK + project +
 * service tag work end-to-end in the real deployment without waiting for a
 * natural error.
 *
 * Guarded by Bearer CRON_SECRET (same secret the Refactor pipeline uses to
 * reach this service) — never reachable anonymously. No-op safe: when
 * SENTRY_DSN is unset the SDK is inert and the call returns `{ captured:false }`.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  const expected = process.env.CRON_SECRET ?? "";
  const received = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const authorized =
    expected.length > 0 &&
    received.length === expected.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dsnConfigured = Boolean(
    process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  );
  const eventId = Sentry.captureException(
    new Error(`Sentry smoke test — cachewarmer — ${new Date().toISOString()}`),
  );
  await Sentry.flush(5000);

  return NextResponse.json({
    captured: dsnConfigured,
    eventId: eventId ?? null,
    dsnConfigured,
  });
}
