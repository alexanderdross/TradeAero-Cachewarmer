import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { fetchSitemapUrls } from '@/lib/sitemap';
import { createRun } from '@/lib/runs';
import crypto from 'crypto';

// This route only enqueues a run row — the heavy validation work is done in
// time-budgeted batches by the /api/cron/warm tick — so it needs no long
// serverless budget.
export const maxDuration = 30;

/**
 * POST /api/jobs/validate
 *
 * Enqueue a standalone schema.org JSON-LD validation run — no channel
 * warming. Same body shape as POST /api/jobs (`{ sitemapUrl?, urls? }`).
 *
 * Creates a `cachewarmer_runs` row with `triggered_by: 'validation_only'`
 * and `status: 'running'`, then returns immediately. The /api/cron/warm
 * cron tick picks the run up and processes it in resumable, cursor-based
 * batches (writing per-URL rows into `cachewarmer_validation_results`).
 * This avoids the old bug where 51k URLs were validated inline in a single
 * invocation that Vercel killed before any progress was written.
 *
 * The existing admin dialog and CSV/JSON export pipelines work unchanged —
 * the run shows up in history with a "validation_only" label and null
 * channel_results.
 */
export async function POST(request: NextRequest) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { sitemapUrl?: string; urls?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body */
  }

  try {
    const config = await loadServiceConfig();
    if (!config.validation.enabled) {
      return NextResponse.json(
        { error: 'Schema validation is disabled (validation_enabled=false in system_settings)' },
        { status: 503 },
      );
    }

    const sitemapUrl = body.sitemapUrl ?? config.sitemapUrl;
    let urls: string[] = body.urls ?? [];

    if (!urls.length) {
      urls = await fetchSitemapUrls(sitemapUrl);
    }
    if (!urls.length) {
      return NextResponse.json({ error: 'No URLs found in sitemap' }, { status: 400 });
    }

    const jobId = crypto.randomUUID();
    const runId = await createRun({
      job_id: jobId,
      sitemap_url: sitemapUrl,
      urls_total: urls.length,
      urls_success: 0,
      urls_failed: 0,
      cursor: 0,
      triggered_by: 'validation_only',
      status: 'running',
    });

    return NextResponse.json({ jobId, runId, urlsTotal: urls.length, queued: true });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
