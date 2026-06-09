import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { fetchSitemapUrls, fetchUrlsFromShards } from '@/lib/sitemap';
import { runAllChannels } from '@/lib/channels';
import { createRun, updateRun, listRuns, persistValidationResults } from '@/lib/runs';
import { triggerIndexing } from '@/lib/orchestration';
import { validateUrlBatch } from '@/lib/validation';
import { isAllowedUrl } from '@/lib/url-guard';
import crypto from 'crypto';

export const maxDuration = 300;

/**
 * Hard budget for the warm phase, kept comfortably under `maxDuration` (300s)
 * so we always have headroom to write a terminal run status + send the HTTP
 * response before Vercel kills the invocation with FUNCTION_INVOCATION_TIMEOUT.
 *
 * Background: channels run in parallel, but several (linkedin/twitter/pinterest)
 * iterate URLs *sequentially* with per-request timeouts + inter-request sleeps.
 * A single slow channel (e.g. linkedin: 20s timeout + 5s sleep per URL) can
 * exceed 300s on its own, and when the function is killed mid-`runAllChannels`
 * the run row is orphaned in `status='running'` forever. Racing the warm
 * against this deadline guarantees we record a terminal status instead.
 */
const WARM_DEADLINE_MS = 250_000;

type Timed<T> = { timedOut: false; value: T } | { timedOut: true; value: null };

/**
 * Resolve to the work's value, or `{ timedOut: true }` if it doesn't settle
 * within `ms`. A rejection propagates (handled by the caller's try/catch).
 * The losing branch keeps running in the background, but the run row has
 * already been finalized, so it can no longer be orphaned.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<Timed<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, value: null }), ms);
  });
  const wrapped = work
    .then((value) => ({ timedOut: false as const, value }))
    .finally(() => { if (timer) clearTimeout(timer); });
  return Promise.race([wrapped, deadline]);
}

/**
 * Clamp a query-param integer to [min, max], falling back to `def` when the
 * param is absent or not a finite number. Note `Number(null)`/`Number('')`
 * coerce to `0`, so a missing param is handled explicitly rather than via
 * the finite-number check.
 */
function clampInt(raw: string | null, def: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function GET(request: NextRequest) {
  if (!verifyApiKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const page = clampInt(request.nextUrl.searchParams.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const limit = clampInt(request.nextUrl.searchParams.get('limit'), 20, 1, 100);
  const { runs, total } = await listRuns(page, limit);
  return NextResponse.json({ runs, total, page, limit });
}

export async function POST(request: NextRequest) {
  if (!verifyApiKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { sitemapUrl?: string; urls?: string[]; sections?: string[] } = {};
  try { body = await request.json(); } catch { /* empty body */ }

  let runId: string | undefined;
  try {
    const config = await loadServiceConfig();
    if (!config.cachwarmerEnabled) return NextResponse.json({ error: 'CacheWarmer is disabled' }, { status: 503 });

    const sitemapUrl = body.sitemapUrl ?? config.sitemapUrl;
    let urls: string[] = body.urls ?? [];
    const sections = Array.isArray(body.sections) && body.sections.length > 0 ? body.sections : null;

    // SSRF guard: reject caller-supplied URLs outside the host allowlist
    // before any outbound fetch happens.
    if (body.sitemapUrl !== undefined && !isAllowedUrl(body.sitemapUrl)) {
      return NextResponse.json(
        { error: `sitemapUrl not permitted by host allowlist: ${body.sitemapUrl}` },
        { status: 400 },
      );
    }
    const disallowed = urls.filter((u) => !isAllowedUrl(u));
    if (disallowed.length) {
      return NextResponse.json(
        { error: 'One or more urls are not permitted by host allowlist', disallowed },
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

    if (!urls.length) {
      urls = sections
        ? await fetchUrlsFromShards(sections)
        : await fetchSitemapUrls(sitemapUrl);
    }
    if (!urls.length) {
      return NextResponse.json({ error: 'No URLs found in sitemap' }, { status: 400 });
    }

    const jobId = crypto.randomUUID();
    const warmStart = Date.now();
    // Stamp an initial heartbeat so the stale-run reaper (`reapStaleRuns`,
    // which matches `heartbeat_at < cutoff` and skips NULLs) can catch this
    // row if it ever does get orphaned. Previously the POST path never wrote a
    // heartbeat, so its orphans were invisible to that reaper.
    runId = await createRun({ job_id: jobId, sitemap_url: sitemapUrl, urls_total: urls.length, urls_success: 0, urls_failed: 0, triggered_by: 'manual', status: 'running', sections, heartbeat_at: new Date().toISOString() });

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

    // Race the warm against the budget. Whatever time validation already
    // consumed is deducted, with a 10s floor so a near-exhausted budget still
    // gives channels a chance rather than insta-failing.
    const remainingMs = Math.max(10_000, WARM_DEADLINE_MS - (Date.now() - warmStart));
    const timed = await withDeadline(runAllChannels(urls, config.channels), remainingMs);

    if (timed.timedOut) {
      // Warming overran the budget — record a terminal status (instead of
      // leaving the row stuck in 'running' when Vercel kills the function) and
      // return 200 so the fire-and-forget caller isn't tripped into a retry.
      await updateRun(runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        urls_failed: urls.length,
      });
      return NextResponse.json(
        { jobId, runId, error: 'warm deadline exceeded', urlsTotal: urls.length },
        { status: 200 },
      );
    }

    const channelResults = timed.value;
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
