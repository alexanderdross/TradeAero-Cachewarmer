import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { createRun } from '@/lib/runs';
import { isAllowedUrl } from '@/lib/url-guard';
import crypto from 'crypto';

// This route only enqueues a run row — the heavy validation work is done in
// time-budgeted batches by the /api/cron/warm tick — so it needs no long
// serverless budget.
export const maxDuration = 30;

/**
 * POST /api/jobs/validate
 *
 * Enqueue a standalone schema.org JSON-LD validation run — no channel
 * warming. Body: `{ sitemapUrl? }` (defaults to the configured sitemap).
 *
 * Creates a `cachewarmer_runs` row with `triggered_by: 'validation_only'`
 * and `status: 'running'`, then returns immediately. The /api/cron/warm
 * cron tick picks the run up, resolves the sitemap, and processes it in
 * resumable, cursor-based batches (writing per-URL rows into
 * `cachewarmer_validation_results`). The sitemap is intentionally NOT
 * resolved here — walking ~20 shards inline would exceed this route's
 * short maxDuration and 504.
 *
 * The existing admin dialog and CSV/JSON export pipelines work unchanged —
 * the run shows up in history with a "validation_only" label and null
 * channel_results.
 */
export async function POST(request: NextRequest) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { sitemapUrl?: string; sections?: string[] } = {};
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
    const sections = Array.isArray(body.sections) && body.sections.length > 0 ? body.sections : null;

    if (body.sitemapUrl !== undefined && !isAllowedUrl(body.sitemapUrl)) {
      return NextResponse.json(
        { error: `sitemapUrl not permitted by host allowlist: ${body.sitemapUrl}` },
        { status: 400 },
      );
    }
    if (sections) {
      const badShards = sections.filter((s) => !isAllowedUrl(s));
      if (badShards.length) {
        return NextResponse.json(
          { error: 'One or more sections are not permitted by host allowlist', disallowed: badShards },
          { status: 400 },
        );
      }
    }

    // Enqueue only — do NOT resolve the sitemap here. fetchSitemapUrls()
    // walks ~20 sitemap shards (index + chunked children, each with its own
    // fetch timeout) and would blow this route's short maxDuration,
    // returning a 504. The /api/cron/warm tick resolves the sitemap under
    // its full 300s budget and stamps urls_total on first pickup.
    const runId = await createRun({
      job_id: crypto.randomUUID(),
      sitemap_url: sitemapUrl,
      urls_total: 0,
      urls_success: 0,
      urls_failed: 0,
      cursor: 0,
      triggered_by: 'validation_only',
      status: 'running',
      sections,
    });

    return NextResponse.json({ runId, queued: true });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
