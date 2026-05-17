import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { fetchSitemapUrls } from '@/lib/sitemap';
import { runAllChannels } from '@/lib/channels';
import { createRun, updateRun, persistValidationResults } from '@/lib/runs';
import { triggerIndexing } from '@/lib/orchestration';
import { validateUrlBatch } from '@/lib/validation';
import crypto from 'crypto';

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const config = await loadServiceConfig();

  if (!config.cachwarmerEnabled) {
    return NextResponse.json({ skipped: true, reason: 'cachewarmer_disabled' });
  }

  // fetchSitemapUrls() now returns [] when the sitemap root is unreachable
  // (e.g. gated trade.aero returns 404), so this branch doubles as the
  // pre-prod kill switch without needing a separate env flag here.
  const urls = await fetchSitemapUrls(config.sitemapUrl);
  if (!urls.length) {
    return NextResponse.json({ skipped: true, reason: 'sitemap_empty', sitemapUrl: config.sitemapUrl });
  }

  const jobId = crypto.randomUUID();
  const runId = await createRun({
    job_id: jobId,
    sitemap_url: config.sitemapUrl,
    urls_total: urls.length,
    urls_success: 0,
    urls_failed: 0,
    triggered_by: 'cron',
    status: 'running',
  });

  try {
    // Pre-warm schema-markup validation gate. Warn-only: every URL is still
    // warmed regardless of validation outcome — see /api/jobs/[id]/validation
    // for the per-URL report surfaced in the admin dashboard.
    if (config.validation.enabled) {
      try {
        const summary = await validateUrlBatch(urls, {
          concurrency: config.validation.concurrency,
          useRemoteValidator: config.validation.useRemoteValidator,
          fetchTimeoutMs: config.validation.fetchTimeoutMs,
        });
        await persistValidationResults(runId, summary);
      } catch (err) {
        console.warn(`[validation] non-fatal: ${(err as Error).message}`);
      }
    }

    const channelResults = await runAllChannels(urls, config.channels);
    const totalSuccess = Object.values(channelResults).reduce((s, r) => s + r.success, 0);
    const totalFailed = Object.values(channelResults).reduce((s, r) => s + r.failed, 0);

    await updateRun(runId, {
      status: 'done',
      finished_at: new Date().toISOString(),
      urls_success: totalSuccess,
      urls_failed: totalFailed,
      channel_results: channelResults,
    });

    if (config.orchestration.enabled && config.indexingEnabled) {
      try { await triggerIndexing(); } catch { /* non-fatal */ }
    }

    return NextResponse.json({ jobId, runId, urlsTotal: urls.length, channelResults });
  } catch (err) {
    await updateRun(runId, { status: 'failed', finished_at: new Date().toISOString() });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
