import { loadConfig } from './config';
import type { WarmingJob } from './types';
import pino from 'pino';

const log = pino({ level: loadConfig().logging.level });

// Lazy-loaded; only imported if supabase is enabled in config.
// Install @supabase/supabase-js separately to use run history persistence.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any | null = null;

async function getClient() {
  const config = loadConfig();
  if (!config.supabase.enabled) return null;
  if (client) return client;

  try {
    // Dynamic import — optional dependency
    const { createClient } = await import('@supabase/supabase-js' as string);
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey);
    log.info('Supabase run history enabled');
  } catch {
    log.warn(
      'Supabase run history is enabled in config but @supabase/supabase-js is not installed. ' +
      'Run: npm install @supabase/supabase-js'
    );
    client = null;
  }
  return client;
}

/**
 * Upsert a warming job run into the cachewarmer_runs Supabase table.
 * No-op if Supabase is disabled or not installed.
 */
export async function logRunToSupabase(job: WarmingJob): Promise<void> {
  const sb = await getClient();
  if (!sb) return;

  try {
    const totalSuccess = Object.values(job.progress).reduce(
      (s, p) => s + (p?.urlsSuccess ?? 0),
      0
    );
    const totalFailed = Object.values(job.progress).reduce(
      (s, p) => s + (p?.urlsFailed ?? 0),
      0
    );

    await sb.from('cachewarmer_runs').upsert(
      {
        job_id: job.jobId,
        sitemap_url: job.sitemapUrl ?? null,
        started_at: job.startedAt,
        finished_at: job.finishedAt ?? null,
        urls_total: job.urls.length,
        urls_success: totalSuccess,
        urls_failed: totalFailed,
        triggered_by: job.triggeredBy,
        status: job.status,
      },
      { onConflict: 'job_id' }
    );
  } catch (err) {
    log.warn({ err }, 'Failed to persist run to Supabase');
  }
}
