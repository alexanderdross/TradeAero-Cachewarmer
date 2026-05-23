import { NextRequest, NextResponse } from 'next/server';
import { verifyCronSecret } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { fetchSitemapUrls, fetchUrlsFromShards } from '@/lib/sitemap';
import { runAllChannels } from '@/lib/channels';
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
import type { ChannelResult } from '@/lib/channels/types';
import crypto from 'crypto';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * URLs processed per batch. Deliberately small: the time-budget check
 * runs only BETWEEN batches, so a single batch must finish well under
 * `maxDuration` even in the worst case — every URL hanging to a channel's
 * 30s fetch timeout at concurrency 3 (~8 URLs ≈ 90s of warming + ~30s of
 * validation ≈ 120s). A larger batch is what produced the 504s.
 */
const BATCH = 8;
/**
 * Wall-clock budget for one invocation. Must leave headroom for one more
 * worst-case batch (~120s) plus the finalize write, all under the 300s
 * `maxDuration` (150s budget + 120s batch ≈ 270s).
 */
const BUDGET_MS = 150_000;
/**
 * Minimum gap between cron-driven warm runs. A manual trigger passes
 * `?force=1` to bypass this throttle.
 */
const MIN_RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * GET /api/cron/warm
 *
 * Cron-tick-driven, resumable warm pipeline. Each invocation:
 *   1. Reaps stale (killed mid-batch) runs via the heartbeat watchdog.
 *   2. Resumes the oldest in-progress run from its `cursor`, OR — when none
 *      is in progress and the throttle allows — starts a fresh warm run.
 *   3. Processes URLs in time-budgeted batches, persisting `cursor` +
 *      accumulated counts after every batch. If the budget runs out the run
 *      stays `running` and the next cron tick picks up where it left off.
 *
 * No self-fetch / self-chaining — progress is purely cursor-based and the
 * cron schedule is what advances long runs.
 */
export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Start the wall-clock budget here — BEFORE the config load and sitemap
  // fetch — so the per-batch budget check accounts for that startup cost
  // (the sitemap walk alone can take tens of seconds) and the whole
  // invocation stays under `maxDuration`.
  const startedMs = Date.now();

  // Watchdog: free up any run whose invocation was killed mid-batch.
  await reapStaleRuns();

  const config = await loadServiceConfig();
  const forced = request.nextUrl.searchParams.get('force') === '1';

  // --- Determine the run to work on -------------------------------------
  let active = await findOldestRunningRun();
  let urls: string[];

  if (!active) {
    // No in-progress run. Decide whether to start a fresh warm run. A
    // validation_only run is always created by /api/jobs/validate, never
    // here, so the cachewarmer-disabled gate applies cleanly to fresh runs.
    if (!forced) {
      const latest = await findLatestFinishedRun();
      if (
        latest?.finished_at &&
        Date.now() - new Date(latest.finished_at).getTime() < MIN_RUN_INTERVAL_MS
      ) {
        return NextResponse.json({ skipped: true, reason: 'recently_warmed' });
      }
    }

    if (!config.cachwarmerEnabled) {
      return NextResponse.json({ skipped: true, reason: 'cachewarmer_disabled' });
    }

    // Fresh cron-driven runs always walk the root sitemap (sections === null);
    // scoped runs are only created by the admin UI via /api/jobs[/validate].
    urls = await fetchSitemapUrls(config.sitemapUrl);
    if (!urls.length) {
      return NextResponse.json({
        skipped: true,
        reason: 'sitemap_empty',
        sitemapUrl: config.sitemapUrl,
      });
    }

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
      return NextResponse.json({ error: 'failed to load freshly created run' }, { status: 500 });
    }
    active = fresh;
  } else {
    // Resuming an existing run — re-fetch its sitemap. The sitemap is stable
    // over the lifetime of a run, so re-fetching per invocation is fine.
    // If the run is scoped to specific sitemap shards (set by /api/jobs or
    // /api/jobs/validate from the admin UI), walk only those instead of the
    // root index.
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
      // Honor operator cancel: re-check status before each batch so a
      // POST /api/jobs/[id]/cancel that landed mid-invocation stops us
      // cleanly without overwriting the row's terminal status.
      const currentStatus = await getRunStatus(active.id!);
      if (currentStatus !== 'running') {
        return NextResponse.json({
          stopped: true,
          reason: currentStatus ?? 'gone',
          runId: active.id,
          cursor,
          urlsTotal: urls.length,
        });
      }

      const slice = urls.slice(cursor, cursor + BATCH);

      // Pre-warm schema-markup validation. Always run it for validation_only
      // runs; gate it behind validation.enabled for warm runs. Warn-only —
      // a validation failure never aborts the batch.
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
        const cr = await runAllChannels(slice, config.channels);
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

      // Persist progress after every batch — this is the write that the old
      // single-shot pipeline never reached.
      const update: Partial<Run> = {
        cursor,
        // Stamp urls_total — validation_only runs are enqueued by
        // /api/jobs/validate with 0; the sitemap is resolved here.
        urls_total: urls.length,
        urls_success: urlsSuccess,
        urls_failed: urlsFailed,
        validation_ok: vOk,
        validation_warnings: vWarn,
        validation_errors: vErr,
        validation_fetch_failed: vFail,
        heartbeat_at: new Date().toISOString(),
      };
      // Never send channel_results for a validation_only run — passing
      // `undefined` could blank the column.
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

      if (
        !validationOnly &&
        config.orchestration.enabled &&
        config.indexingEnabled
      ) {
        try {
          await triggerIndexing();
        } catch {
          /* non-fatal */
        }
      }
    }

    return NextResponse.json({
      runId: active.id,
      cursor,
      urlsTotal: urls.length,
      done,
    });
  } catch (err) {
    // If the row was already cancelled by an operator while a batch was
    // in flight, leave the terminal `cancelled` status alone — don't
    // overwrite it with `failed`.
    const current = await getRunStatus(active.id!).catch(() => null);
    if (current === 'running') {
      await updateRun(active.id!, {
        status: 'failed',
        finished_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
