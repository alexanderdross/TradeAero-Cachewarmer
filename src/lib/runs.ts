import { getSupabase } from './supabase';
import type { ChannelResult } from './channels/types';
import type { RunValidationSummary, UrlValidationReport } from './validation/types';

export interface Run {
  id?: string;
  job_id: string;
  sitemap_url?: string;
  urls_total: number;
  urls_success: number;
  urls_failed: number;
  // 'validation_only' = pre-warm validator was run standalone, no channels
  // were called. Validation rows in cachewarmer_validation_results are still
  // populated; channel_results stays null.
  triggered_by: 'cron' | 'manual' | 'validation_only';
  status: 'running' | 'done' | 'failed' | 'cancelled';
  started_at?: string;
  finished_at?: string;
  channel_results?: Record<string, ChannelResult>;
  validation_ok?: number | null;
  validation_warnings?: number | null;
  validation_errors?: number | null;
  validation_fetch_failed?: number | null;
  /** Next URL index to process — drives resumable, chunked runs. */
  cursor?: number;
  /** Progress timestamp written every batch; used by the stale-run watchdog. */
  heartbeat_at?: string;
  /**
   * Sitemap shard URLs the run is scoped to (e.g. only the aircraft + jobs
   * shards). NULL or absent = walk the whole root index, current behavior.
   * Stored as JSONB to keep the column shape flexible if we ever switch to
   * `{ url, label }[]`.
   */
  sections?: string[] | null;
}

export async function createRun(run: Omit<Run, 'id' | 'started_at'>): Promise<string> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('cachewarmer_runs')
    .insert({ ...run, started_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function updateRun(id: string, update: Partial<Run>): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('cachewarmer_runs').update(update).eq('id', id);
}

/**
 * Stale-run watchdog. A run whose serverless invocation was killed mid-batch
 * stops updating `heartbeat_at`. This marks any such `running` row as failed
 * so a fresh run can start and the dashboard stops showing a frozen run.
 *
 * Rows with a NULL `heartbeat_at` are intentionally NOT matched by `.lt(...)`
 * — a freshly created run writes its first heartbeat on the first batch, so
 * the only window where heartbeat is NULL is the first few seconds of a run.
 *
 * Returns the number of rows reaped (best-effort; 0 if the count is absent).
 *
 * The default threshold (60 min) must stay well above the interval at which a
 * live run advances its `heartbeat_at` — otherwise a run that is merely
 * between ticks would be wrongly reaped as "dead", and long runs could never
 * complete. A self-chaining warm run (see `/api/cron/warm`) writes a heartbeat
 * after every batch and immediately kicks the next tick, so heartbeats land
 * every ~1-2 min; 60 min leaves ample margin (including a cold start or a
 * single dropped chain link that the once-daily cron then recovers).
 */
export async function reapStaleRuns(staleMs = 3_600_000): Promise<number> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const { count, error } = await supabase
    .from('cachewarmer_runs')
    .update(
      { status: 'failed', finished_at: new Date().toISOString() },
      { count: 'exact' },
    )
    .eq('status', 'running')
    .lt('heartbeat_at', cutoff);
  if (error) {
    console.warn(`[runs] reapStaleRuns failed: ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

/**
 * The oldest still-`running` run, if any. The cron tick resumes this run
 * from its `cursor` before considering whether to start a fresh run.
 */
export async function findOldestRunningRun(): Promise<Run | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('cachewarmer_runs')
    .select('*')
    .eq('status', 'running')
    .order('started_at', { ascending: true })
    .limit(1);
  const rows = (data ?? []) as Run[];
  return rows[0] ?? null;
}

/**
 * The most recently finished run (status `done` or `failed`). Used to throttle
 * how often a fresh cron-driven warm run is started.
 */
export async function findLatestFinishedRun(): Promise<Run | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('cachewarmer_runs')
    .select('*')
    .in('status', ['done', 'failed'])
    .order('finished_at', { ascending: false })
    .limit(1);
  const rows = (data ?? []) as Run[];
  return rows[0] ?? null;
}

/**
 * Cancel a run on operator request. Atomic: only flips a row that is
 * currently `running`, so a click that races with natural completion
 * (status already `done` / `failed`) is a no-op and returns false. The
 * cron tick re-checks status at the top of each batch (see
 * `/api/cron/warm`) and bails cleanly when it sees `cancelled`.
 */
export async function cancelRun(id: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('cachewarmer_runs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'running')
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * Lightweight status probe used by the cron tick between batches to detect
 * a cancel signal without re-fetching the whole row. Returns `null` if the
 * row is gone (defensive — shouldn't happen in practice).
 */
export async function getRunStatus(id: string): Promise<Run['status'] | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('cachewarmer_runs')
    .select('status')
    .eq('id', id)
    .maybeSingle();
  return (data as { status: Run['status'] } | null)?.status ?? null;
}

export async function getRun(id: string): Promise<Run | null> {
  const supabase = getSupabase();
  const { data } = await supabase.from('cachewarmer_runs').select('*').eq('id', id).single();
  return (data as Run | null);
}

export async function listRuns(page = 1, limit = 20) {
  const supabase = getSupabase();
  const from = (page - 1) * limit;
  const { data, count } = await supabase
    .from('cachewarmer_runs')
    .select('*', { count: 'exact' })
    .order('started_at', { ascending: false })
    .range(from, from + limit - 1);
  return { runs: (data ?? []) as Run[], total: count ?? 0 };
}

/**
 * Insert the per-URL validation rows for a (batch of a) run into
 * `cachewarmer_validation_results`. This is the chunked-INSERT half of the
 * old `persistValidationResults` — it does NOT touch `cachewarmer_runs`, so
 * the resumable cron pipeline can call it once per batch and own the
 * accumulated summary counts itself via `updateRun`.
 *
 * Failures here are non-fatal — validation is a warn-only observability
 * layer, so DB errors are swallowed and logged instead of blocking warming.
 */
export async function insertValidationReports(
  runId: string,
  summary: RunValidationSummary,
): Promise<void> {
  const supabase = getSupabase();

  const rows = summary.reports.map((r: UrlValidationReport) => ({
    run_id: runId,
    url: r.url,
    status: r.status,
    http_status: r.httpStatus ?? null,
    detected_types: r.detectedTypes,
    json_ld_count: r.jsonLdCount,
    error_count: r.issues.filter((i) => i.severity === 'error').length,
    warning_count: r.issues.filter((i) => i.severity === 'warning').length,
    issues: r.issues,
    duration_ms: r.durationMs,
  }));

  if (rows.length === 0) return;

  // Chunk to stay well under Supabase's request size limit for runs with
  // tens of thousands of URLs.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase
      .from('cachewarmer_validation_results')
      .insert(rows.slice(i, i + CHUNK));
    if (error) {
      console.warn(`[validation] persist chunk ${i / CHUNK} failed: ${error.message}`);
    }
  }
}

/**
 * Persist per-URL validation results for a run. Writes one row per URL into
 * `cachewarmer_validation_results` and updates the parent `cachewarmer_runs`
 * row with summary counts. Failures here are non-fatal — validation is a
 * warn-only observability layer, so we swallow DB errors and log instead of
 * blocking the warming pipeline.
 *
 * Retained for any non-chunked caller; the resumable cron pipeline uses
 * `insertValidationReports` plus its own accumulated `updateRun` instead.
 */
export async function persistValidationResults(
  runId: string,
  summary: RunValidationSummary,
): Promise<void> {
  await insertValidationReports(runId, summary);

  await updateRun(runId, {
    validation_ok: summary.ok,
    validation_warnings: summary.warningsOnly,
    validation_errors: summary.errors,
    validation_fetch_failed: summary.fetchFailed,
  });
}

export interface ValidationResultRow {
  id: string;
  run_id: string;
  url: string;
  status: string;
  http_status: number | null;
  detected_types: string[];
  json_ld_count: number;
  error_count: number;
  warning_count: number;
  issues: unknown;
  duration_ms: number | null;
  created_at: string;
}

export async function listValidationResults(
  runId: string,
  filter?: { status?: string },
): Promise<ValidationResultRow[]> {
  const supabase = getSupabase();
  let query = supabase
    .from('cachewarmer_validation_results')
    .select('*')
    .eq('run_id', runId)
    .order('created_at', { ascending: true });

  if (filter?.status) {
    query = query.eq('status', filter.status);
  }

  const { data, error } = await query;
  if (error) {
    // Table may not exist yet — treat as empty.
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      return [];
    }
    throw error;
  }
  return (data ?? []) as ValidationResultRow[];
}
