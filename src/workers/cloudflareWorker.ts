/**
 * Cloudflare Worker — batch-purges cached URLs via the Cache Purge API,
 * then re-warms each URL with an HTTP GET so the edge has a fresh copy.
 *
 * Cloudflare accepts max 30 URLs per purge request; batching is handled here.
 */
import { Worker, Job } from 'bullmq';
import axios from 'axios';
import pLimit from 'p-limit';
import pino from 'pino';
import { getRedisConnection } from '../queue';
import { loadConfig } from '../config';
import { markChannelRunning, markChannelDone, markChannelFailed } from '../jobCoordinator';
import type { ChannelJobData } from '../types';

const CF_PURGE_BATCH_SIZE = 30;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function startCloudflareWorker(log: pino.Logger): Worker {
  const config = loadConfig();

  return new Worker<ChannelJobData>(
    'cachewarmer:cloudflare',
    async (job: Job<ChannelJobData>) => {
      const { jobId, urls } = job.data;
      let success = 0;
      let failed = 0;

      await markChannelRunning(jobId, 'cloudflare');
      log.info({ jobId, urlCount: urls.length }, '[cloudflare] warming started');

      try {
        // Step 1: batch purge
        const batches = chunk(urls, CF_PURGE_BATCH_SIZE);
        for (const batch of batches) {
          try {
            await axios.post(
              `https://api.cloudflare.com/client/v4/zones/${config.cloudflare.zoneId}/purge_cache`,
              { files: batch },
              {
                headers: {
                  Authorization: `Bearer ${config.cloudflare.apiToken}`,
                  'Content-Type': 'application/json',
                },
                timeout: 15_000,
              }
            );
            log.debug({ batchSize: batch.length }, '[cloudflare] purge batch OK');
          } catch (err) {
            log.warn({ err: (err as Error).message, batchSize: batch.length }, '[cloudflare] purge batch failed');
          }
        }

        // Step 2: re-warm each URL
        const limit = pLimit(4);
        await Promise.all(
          urls.map((url) =>
            limit(async () => {
              const t = Date.now();
              try {
                await axios.get(url, {
                  timeout: 30_000,
                  headers: { 'User-Agent': 'TradeAero-CacheWarmer/1.0', 'Cache-Control': 'no-cache' },
                  maxRedirects: 5,
                  validateStatus: (s) => s < 500,
                });
                success++;
                log.debug({ url, durationMs: Date.now() - t }, '[cloudflare] re-warm OK');
              } catch (err) {
                failed++;
                log.warn({ url, err: (err as Error).message }, '[cloudflare] re-warm failed');
              }
            })
          )
        );

        log.info({ jobId, success, failed }, '[cloudflare] warming complete');
        await markChannelDone(jobId, 'cloudflare', { urlsSuccess: success, urlsFailed: failed });
      } catch (err) {
        log.error({ err, jobId }, '[cloudflare] worker fatal error');
        await markChannelFailed(jobId, 'cloudflare', { urlsSuccess: success, urlsFailed: failed });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
