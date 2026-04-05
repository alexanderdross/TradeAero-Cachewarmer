import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { fetchSitemapUrls } from '@/lib/sitemap';
import { runAllChannels } from '@/lib/channels';
import { createRun, updateRun, listRuns } from '@/lib/runs';
import { triggerIndexing } from '@/lib/orchestration';
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
  const runId = await createRun({ job_id: jobId, sitemap_url: sitemapUrl, urls_total: urls.length, urls_success: 0, urls_failed: 0, triggered_by: 'manual', status: 'running' });

  try {
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
      try { await triggerIndexing(config.orchestration.config); } catch { /* non-fatal */ }
    }

    return NextResponse.json({ jobId, runId, channelResults, urlsTotal: urls.length });
  } catch (err) {
    await updateRun(runId, { status: 'failed', finished_at: new Date().toISOString() });
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
