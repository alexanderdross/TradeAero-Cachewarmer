import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { fetchSitemapUrls } from '@/lib/sitemap';
import { runAllChannels } from '@/lib/channels';
import { createRun, updateRun, listRuns, persistValidationResults } from '@/lib/runs';
import { triggerIndexing } from '@/lib/orchestration';
import { validateUrlBatch } from '@/lib/validation';
import crypto from 'crypto';

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!verifyApiKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const page = Number(request.nextUrl.searchParams.get('page') ?? '1');
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '20');
  const { runs, total } = await listRuns(page, limit);
  return NextResponse.json({ runs, total, page, limit });
}

export async function POST(request: NextRequest) {
  if (!verifyApiKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { sitemapUrl?: string; urls?: string[] } = {};
  try { body = await request.json(); } catch { /* empty body */ }

  let runId: string | undefined;
  try {
    const config = await loadServiceConfig();
    if (!config.cachwarmerEnabled) return NextResponse.json({ error: 'CacheWarmer is disabled' }, { status: 503 });

    const sitemapUrl = body.sitemapUrl ?? config.sitemapUrl;
    let urls: string[] = body.urls ?? [];

    if (!urls.length) {
      urls = await fetchSitemapUrls(sitemapUrl);
    }
    if (!urls.length) {
      return NextResponse.json({ error: 'No URLs found in sitemap' }, { status: 400 });
    }

    const jobId = crypto.randomUUID();
    runId = await createRun({ job_id: jobId, sitemap_url: sitemapUrl, urls_total: urls.length, urls_success: 0, urls_failed: 0, triggered_by: 'manual', status: 'running' });

    // Pre-warm schema-markup validation gate. Warn-only: results are
    // persisted to cachewarmer_validation_results for the admin report but
    // every URL is still warmed regardless of validation outcome.
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

    return NextResponse.json({ jobId, runId, channelResults, urlsTotal: urls.length });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (runId) await updateRun(runId, { status: 'failed', finished_at: new Date().toISOString() }).catch(() => {});
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
