import { getSupabase } from './supabase';
import type { ChannelResult } from './channels/types';

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
