import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';

export const maxDuration = 10;

/**
 * POST /api/admin/trigger
 * Manually kick off a warm run from the admin dashboard.
 * Auth: x-api-key header (CACHEWARMER_API_KEY env var).
 * Returns immediately — the actual warming runs as an independent invocation.
 */
export async function POST(request: NextRequest) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured on CacheWarmer' }, { status: 500 });
  }

  // Resolve the base URL of this deployment
  const baseUrl =
    process.env.CACHEWARMER_INTERNAL_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3001');

  // Fire-and-forget: kicks the /api/cron/warm tick once. `?force=1` bypasses
  // the MIN_RUN_INTERVAL_MS throttle so a manual trigger always starts (or
  // resumes) a run. The run then advances on the regular cron schedule.
  void fetch(`${baseUrl}/api/cron/warm?force=1`, {
    headers: { Authorization: `Bearer ${cronSecret}` },
  }).catch(() => {});

  return NextResponse.json({ triggered: true });
}
