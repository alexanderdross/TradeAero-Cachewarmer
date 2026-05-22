import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { fetchSitemapUrls } from '@/lib/sitemap';
import { createRun, updateRun, persistValidationResults } from '@/lib/runs';
import { validateUrlBatch } from '@/lib/validation';
import crypto from 'crypto';

export const maxDuration = 300;

/**
 * POST /api/jobs/validate
 *
 * Run the schema.org JSON-LD validator standalone — without warming any
 * channels. Same body shape as POST /api/jobs (`{ sitemapUrl?, urls? }`).
 *
 * Persists a `cachewarmer_runs` row with `triggered_by: 'validation_only'`
 * plus per-URL rows in `cachewarmer_validation_results`. The existing admin
 * dialog and CSV/JSON export pipelines work unchanged — the run just shows
 * up in the history list with a distinctive "validation_only" label and
 * null channel_results.
 *
 * Use cases:
 *   - Spot-check JSON-LD changes after editing a builder under
 *     src/lib/seo/* or src/components/aircraft/AircraftJsonLd.tsx, without
 *     burning Vercel CPU on cache warming or triggering social/search
 *     channel submissions.
 *   - Validate ad-hoc URL lists from the admin UI on demand.
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

  let runId: string | undefined;
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
    runId = await createRun({
      job_id: jobId,
      sitemap_url: sitemapUrl,
      urls_total: urls.length,
      urls_success: 0,
      urls_failed: 0,
      triggered_by: 'validation_only',
      status: 'running',
    });

    const summary = await validateUrlBatch(urls, {
      concurrency: config.validation.concurrency,
      useRemoteValidator: config.validation.useRemoteValidator,
      fetchTimeoutMs: config.validation.fetchTimeoutMs,
    });
    await persistValidationResults(runId, summary);

    await updateRun(runId, {
      status: 'done',
      finished_at: new Date().toISOString(),
      // Channel-warming wasn't attempted — record validation totals as the
      // run's "success/failed" so the existing dashboard chart renders
      // something meaningful for validation_only runs.
      urls_success: summary.ok + summary.warningsOnly,
      urls_failed: summary.errors + summary.fetchFailed,
    });

    return NextResponse.json({
      jobId,
      runId,
      urlsTotal: urls.length,
      validation: {
        ok: summary.ok,
        warnings: summary.warningsOnly,
        errors: summary.errors,
        fetchFailed: summary.fetchFailed,
      },
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (runId) {
      await updateRun(runId, { status: 'failed', finished_at: new Date().toISOString() }).catch(
        () => {},
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
