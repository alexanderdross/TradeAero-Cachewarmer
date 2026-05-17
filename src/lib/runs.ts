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
  triggered_by: 'cron' | 'manual';
  status: 'running' | 'done' | 'failed';
  started_at?: string;
  finished_at?: string;
  channel_results?: Record<string, ChannelResult>;
  validation_ok?: number | null;
  validation_warnings?: number | null;
  validation_errors?: number | null;
  validation_fetch_failed?: number | null;
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
 * Persist per-URL validation results for a run. Writes one row per URL into
 * `cachewarmer_validation_results` and updates the parent `cachewarmer_runs`
 * row with summary counts. Failures here are non-fatal — validation is a
 * warn-only observability layer, so we swallow DB errors and log instead of
 * blocking the warming pipeline.
 */
export async function persistValidationResults(
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

  if (rows.length > 0) {
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
