import { getRedisConnection } from './queue';
import { loadConfig } from './config';
import { triggerIndexing } from './orchestration';
import type { ChannelName, WarmingJob, ChannelProgress } from './types';
import pino from 'pino';

const log = pino({ level: loadConfig().logging.level });

const JOB_PREFIX = 'cachewarmer:job:';
const JOB_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export async function saveJob(job: WarmingJob): Promise<void> {
  const redis = getRedisConnection();
  await redis.setex(`${JOB_PREFIX}${job.jobId}`, JOB_TTL_SECONDS, JSON.stringify(job));
}

export async function getJob(jobId: string): Promise<WarmingJob | null> {
  const redis = getRedisConnection();
  const raw = await redis.get(`${JOB_PREFIX}${jobId}`);
  if (!raw) return null;
  return JSON.parse(raw) as WarmingJob;
}

export async function listJobs(
  page: number,
  limit: number
): Promise<{ runs: WarmingJob[]; total: number }> {
  const redis = getRedisConnection();
  const keys = await redis.keys(`${JOB_PREFIX}*`);
  const total = keys.length;

  // Sort by embedded timestamp in jobId (UUIDs sort lexicographically by creation time)
  const pageKeys = keys.sort().reverse().slice((page - 1) * limit, page * limit);

  const runs: WarmingJob[] = [];
  for (const key of pageKeys) {
    const raw = await redis.get(key);
    if (raw) runs.push(JSON.parse(raw) as WarmingJob);
  }

  return { runs, total };
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

export async function markChannelRunning(jobId: string, channel: ChannelName): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  const prev = job.progress[channel];
  job.progress[channel] = {
    status: 'running',
    urlsTotal: prev?.urlsTotal ?? 0,
    urlsSuccess: 0,
    urlsFailed: 0,
  };
  await saveJob(job);
}

export async function markChannelDone(
  jobId: string,
  channel: ChannelName,
  result: Pick<ChannelProgress, 'urlsSuccess' | 'urlsFailed'>
): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  const prev = job.progress[channel];
  job.progress[channel] = {
    status: 'done',
    urlsTotal: prev?.urlsTotal ?? result.urlsSuccess + result.urlsFailed,
    urlsSuccess: result.urlsSuccess,
    urlsFailed: result.urlsFailed,
  };

  const allSettled = job.channels.every((ch) => {
    const p = job.progress[ch];
    return p?.status === 'done' || p?.status === 'failed';
  });

  if (allSettled) {
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    log.info({ jobId }, 'All channels complete — warming job done');

    const config = loadConfig();
    if (config.orchestration.triggerIndexingAfterWarming) {
      try {
        await triggerIndexing();
        log.info({ jobId }, 'Dispatched TradeAero-Indexing workflow');
      } catch (err) {
        log.error({ err, jobId }, 'Failed to dispatch indexing workflow');
      }
    }
  }

  await saveJob(job);
}

export async function markChannelFailed(
  jobId: string,
  channel: ChannelName,
  result: Pick<ChannelProgress, 'urlsSuccess' | 'urlsFailed'>
): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  const prev = job.progress[channel];
  job.progress[channel] = {
    status: 'failed',
    urlsTotal: prev?.urlsTotal ?? result.urlsSuccess + result.urlsFailed,
    urlsSuccess: result.urlsSuccess,
    urlsFailed: result.urlsFailed,
  };

  await saveJob(job);
}
