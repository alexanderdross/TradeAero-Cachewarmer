/**
 * Vercel Worker — re-warms URLs through the Vercel edge network.
 *
 * Sends requests with Cache-Control: no-cache to bypass stale edge entries
 * and force a fresh fetch from the Next.js origin, re-populating the edge cache.
 *
 * For granular cache invalidation (specific paths/tags), use Next.js
 * revalidatePath / revalidateTag from your application code instead.
 */
import { Worker, Job } from 'bullmq';
import axios from 'axios';
import pLimit from 'p-limit';
import pino from 'pino';
import { getRedisConnection } from '../queue';
import { loadConfig } from '../config';
import { markChannelRunning, markChannelDone, markChannelFailed } from '../jobCoordinator';
import type { ChannelJobData } from '../types';

export function startVercelWorker(log: pino.Logger): Worker {
  const config = loadConfig();

  return new Worker<ChannelJobData>(
    'cachewarmer:vercel',
    async (job: Job<ChannelJobData>) => {
      const { jobId, urls } = job.data;
      const limit = pLimit(4);
      let success = 0;
      let failed = 0;

      await markChannelRunning(jobId, 'vercel');
      log.info({ jobId, urlCount: urls.length }, '[vercel] warming started');

      try {
        await Promise.all(
          urls.map((url) =>
            limit(async () => {
              const t = Date.now();
              try {
                await axios.get(url, {
                  timeout: 30_000,
                  headers: {
                    'User-Agent': 'TradeAero-CacheWarmer/1.0',
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache',
                    // Vercel honours x-prerender-revalidate for on-demand ISR revalidation
                    // if a bypass token is configured in your Next.js project.
                    // Set VERCEL_BYPASS_TOKEN in config.local.yaml and uncomment:
                    // 'x-prerender-revalidate': config.vercel.bypassToken,
                  },
                  maxRedirects: 5,
                  validateStatus: (s) => s < 500,
                });
                success++;
                log.debug({ url, durationMs: Date.now() - t }, '[vercel] warm OK');
              } catch (err) {
                failed++;
                log.warn({ url, err: (err as Error).message }, '[vercel] warm failed');
              }
            })
          )
        );

        log.info({ jobId, success, failed }, '[vercel] warming complete');
        await markChannelDone(jobId, 'vercel', { urlsSuccess: success, urlsFailed: failed });
      } catch (err) {
        log.error({ err, jobId }, '[vercel] worker fatal error');
        await markChannelFailed(jobId, 'vercel', { urlsSuccess: success, urlsFailed: failed });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
