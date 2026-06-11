import { NextRequest, NextResponse, after } from 'next/server';
import { verifyCronSecret } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { fetchSitemapUrls, fetchUrlsFromShards } from '@/lib/sitemap';
import { runAllChannels, WARM_CHANNELS } from '@/lib/channels';
import {
  createRun,
  updateRun,
  insertValidationReports,
  reapStaleRuns,
  findOldestRunningRun,
  findLatestFinishedRun,
  getRun,
  getRunStatus,
  type Run,
} from '@/lib/runs';
import { triggerIndexing } from '@/lib/orchestration';
import { validateUrlBatch } from '@/lib/validation';
import { pingHeartbeat } from '@/lib/heartbeat';
import type { ChannelResult } from '@/lib/channels/types';
import crypto from 'crypto';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * URLs processed per batch. The cron warm runs only the WARM tier
 * (cdn/cloudflare/vercel) — fast parallel GETs with no per-URL social sleeps —
 * so a batch settles in seconds and we can use a larger batch than the old
 * all-channels path (which had to stay tiny because pinterest's 4s/URL sleep
 * dominated). The per-channel `WARM_DEADLINE_MS` still caps a slow batch.
 */
const BATCH = 40;
/**
 * Wall-clock budget for one invocation's batch loop. Kept well under
 * `maxDuration` (300s) so the after()-scheduled pipeline always finishes —
 * including the finalize write + the self-chain kick — before Vercel reclaims
 * the function.
 */
const BUDGET_MS = 120_000;
/**
 * Per-channel deadline handed to runAllChannels. Generous (a healthy warm
 * answers in well under a second per URL); it only bites if a channel hangs,
 * in which case it returns real partial counts instead of monopolising the
 * budget.
 */
const WARM_DEADLINE_MS = 60_000;
/**
 * Minimum gap between cron-driven warm runs. A manual trigger passes
 * `?force=1` to bypass this throttle.
 */
const MIN_RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Resolve this deployment's own base URL so a tick can kick the next one.
 * Mirrors /api/admin/trigger.
 */
function selfBaseUrl(): string {
  return (
    process.env.CACHEWARMER_INTERNAL_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3001')
  );
}

/**
 * Fire-and-forget kick of the next warm tick so a long (resumable) run advances
 * immediately instead of waiting for the once-daily cron. The next tick acks
 * instantly (it schedules its own work in after()), so this fetch returns in
 * milliseconds — no nested keep-alive, no FUNCTION_INVOCATION_TIMEOUT. `?force=1`
 * skips the throttle; since a run is already `running`, the next tick resumes it
 * from its cursor rather than starting a fresh run.
 */
async function chainNextTick(): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return;
  try {
    await fetch(`${selfBaseUrl()}/api/cron/warm?force=1`, {
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Non-fatal: if the kick is lost the run stays `running` and the daily
    // cron resumes it on the next tick (reaper threshold stays above the
    // per-tick interval so an actively-chaining run is never reaped).
  }
}

/**
 * GET /api/cron/warm
 *
 * Cron-tick-driven, resumable, **self-chaining** warm pipeline. The handler
 * acks immediately and runs the work in `after()`; each invocation:
 *   1. Reaps stale (killed mid-batch) runs via the heartbeat watchdog.
 *   2. Resumes the oldest in-progress run from its `cursor`, OR — when none
 *      is in progress and the throttle allows — starts a fresh warm run.
 *   3. Processes URLs in time-budgeted batches (WARM tier only), persisting
 *      `cursor` + accumulated counts after every batch.
 *   4. If the budget runs out with URLs remaining, kicks the next tick so the
 *      run advances right away. The once-daily Vercel cron is now only a
 *      backstop that starts a fresh warm / recovers a dropped chain.
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const forced = request.nextUrl.searchParams.get('force') === '1';

  // Ack immediately and do the work after the response is flushed. This keeps
  // the self-chain kick (chainNextTick) cheap — the kicked invocation returns
  // here in milliseconds while its own batch loop runs in its own after().
  after(() => runWarmTick(forced));

  return NextResponse.json({ accepted: true });
}

async function runWarmTick(forced: boolean): Promise<void> {
  // Start the wall-clock budget before the config load and sitemap fetch so the
  // per-batch budget check accounts for that startup cost.
  const startedMs = Date.now();

  // Watchdog: free up any run whose invocation was killed mid-batch.
  const reaped = await reapStaleRuns();
  if (reaped > 0) {
    console.warn(`[warm] reaped ${reaped} stale run(s) stuck in 'running' — possible stall`);
  }
  // Dead-man's-switch: healthy tick pings HEARTBEAT_URL; a tick that had to reap
  // pings <url>/fail. No-op when HEARTBEAT_URL is unset.
  await pingHeartbeat(reaped === 0);

  const config = await loadServiceConfig();

  // --- Determine the run to work on -------------------------------------
  let active = await findOldestRunningRun();
  let urls: string[];

  if (!active) {
    if (!forced) {
      const latest = await findLatestFinishedRun();
      if (
        latest?.finished_at &&
        Date.now() - new Date(latest.finished_at).getTime() < MIN_RUN_INTERVAL_MS
      ) {
        return; // recently_warmed
      }
    }

    if (!config.cachwarmerEnabled) return; // cachewarmer_disabled

    // Fresh cron-driven runs always walk the root sitemap (sections === null);
    // scoped runs are only created by the admin UI via /api/jobs[/validate].
    urls = await fetchSitemapUrls(config.sitemapUrl);
    if (!urls.length) return; // sitemap_empty

    const runId = await createRun({
      job_id: crypto.randomUUID(),
      sitemap_url: config.sitemapUrl,
      urls_total: urls.length,
      urls_success: 0,
      urls_failed: 0,
      cursor: 0,
      triggered_by: forced ? 'manual' : 'cron',
      status: 'running',
    });

    const fresh = await getRun(runId);
    if (!fresh) {
      console.error('[warm] failed to load freshly created run');
      return;
    }
    active = fresh;
  } else {
    // Resuming an existing run — re-fetch its sitemap (stable over the run's
    // lifetime). Scoped runs (set by the admin UI) walk only their shards.
    const scopedSections = Array.isArray(active.sections) && active.sections.length > 0
      ? active.sections
      : null;
    urls = scopedSections
      ? await fetchUrlsFromShards(scopedSections)
      : await fetchSitemapUrls(active.sitemap_url ?? config.sitemapUrl);
  }

  // --- Process the active run in time-budgeted batches ------------------
  const validationOnly = active.triggered_by === 'validation_only';

  let cursor = active.cursor ?? 0;
  let urlsSuccess = active.urls_success;
  let urlsFailed = active.urls_failed;
  const channelResults: Record<string, ChannelResult> = { ...(active.channel_results ?? {}) };
  let vOk = active.validation_ok ?? 0;
  let vWarn = active.validation_warnings ?? 0;
  let vErr = active.validation_errors ?? 0;
  let vFail = active.validation_fetch_failed ?? 0;

  try {
    while (cursor < urls.length) {
      // Honor operator cancel between batches.
      const currentStatus = await getRunStatus(active.id!);
      if (currentStatus !== 'running') return; // stopped/cancelled/gone

      const slice = urls.slice(cursor, cursor + BATCH);

      // Pre-warm schema-markup validation. Always for validation_only runs;
      // otherwise gated behind validation.enabled. Warn-only.
      if (validationOnly || config.validation.enabled) {
        try {
          const summary = await validateUrlBatch(slice, {
            concurrency: config.validation.concurrency,
            useRemoteValidator: config.validation.useRemoteValidator,
            fetchTimeoutMs: config.validation.fetchTimeoutMs,
          });
          await insertValidationReports(active.id!, summary);
          vOk += summary.ok;
          vWarn += summary.warningsOnly;
          vErr += summary.errors;
          vFail += summary.fetchFailed;
        } catch (err) {
          console.warn(`[validation] non-fatal: ${(err as Error).message}`);
        }
      }

      if (!validationOnly) {
        // WARM tier only: distribution channels (social + search) are slow
        // (mandatory per-URL sleeps) and rate-limited — firing them on every
        // URL of a ~60k full warm is what made it impossible to complete and
        // hammered those APIs. Cache warming is the WARM tier's job; the
        // per-publish targeted path owns distribution.
        const cr = await runAllChannels(slice, config.channels, {
          only: WARM_CHANNELS,
          deadlineMs: WARM_DEADLINE_MS,
        });
        for (const [name, result] of Object.entries(cr)) {
          const prev = channelResults[name] ?? { success: 0, failed: 0 };
          channelResults[name] = {
            success: prev.success + result.success,
            failed: prev.failed + result.failed,
          };
        }
        urlsSuccess += Object.values(cr).reduce((s, r) => s + r.success, 0);
        urlsFailed += Object.values(cr).reduce((s, r) => s + r.failed, 0);
      }

      cursor += slice.length;

      // Persist progress after every batch.
      const update: Partial<Run> = {
        cursor,
        urls_total: urls.length,
        urls_success: urlsSuccess,
        urls_failed: urlsFailed,
        validation_ok: vOk,
        validation_warnings: vWarn,
        validation_errors: vErr,
        validation_fetch_failed: vFail,
        heartbeat_at: new Date().toISOString(),
      };
      if (!validationOnly) update.channel_results = channelResults;
      await updateRun(active.id!, update);

      if (Date.now() - startedMs > BUDGET_MS) break;
    }

    const done = cursor >= urls.length;

    if (done) {
      await updateRun(active.id!, {
        status: 'done',
        finished_at: new Date().toISOString(),
        urls_success: urlsSuccess,
        urls_failed: urlsFailed,
      });

      if (!validationOnly && config.orchestration.enabled && config.indexingEnabled) {
        try {
          await triggerIndexing();
        } catch {
          /* non-fatal */
        }
      }
      return;
    }

    // Budget hit with URLs remaining — self-chain so the run advances now
    // instead of waiting for the once-daily cron. Re-check status first so a
    // cancel that landed during the last batch doesn't get re-kicked.
    const stillRunning = (await getRunStatus(active.id!).catch(() => null)) === 'running';
    if (stillRunning) await chainNextTick();
  } catch (err) {
    // Leave a terminal `cancelled` status alone; otherwise mark failed.
    const current = await getRunStatus(active.id!).catch(() => null);
    if (current === 'running') {
      await updateRun(active.id!, {
        status: 'failed',
        finished_at: new Date().toISOString(),
      }).catch(() => {});
    }
    console.error(`[warm] tick failed: ${(err as Error).message}`);
  }
}
