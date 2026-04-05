/**
 * CDN Worker — warms edge cache by sending HTTP GET requests with no-cache headers.
 *
 * This forces the CDN (Cloudflare, Vercel, etc.) to fetch a fresh copy from the origin
 * and store it at the edge, so subsequent real-user requests are served instantly.
 *
 * For JavaScript-rendered pages (SSR hydration, client-only routes), replace the axios
 * call with Puppeteer: `npm install puppeteer`, launch a headless browser, and call
 * `page.goto(url, { waitUntil: 'networkidle0' })` to ensure full JS execution before caching.
 */
import { Worker, Job } from 'bullmq';
import axios from 'axios';
import pLimit from 'p-limit';
import pino from 'pino';
import { getRedisConnection } from '../queue';
import { loadConfig } from '../config';
import { markChannelRunning, markChannelDone, markChannelFailed } from '../jobCoordinator';
import type { ChannelJobData } from '../types';

export function startCdnWorker(log: pino.Logger): Worker {
  const config = loadConfig();

  return new Worker<ChannelJobData>(
    'cachewarmer:cdn',
    async (job: Job<ChannelJobData>) => {
      const { jobId, urls } = job.data;
      const limit = pLimit(config.cdn.concurrency || 3);
      let success = 0;
      let failed = 0;

      await markChannelRunning(jobId, 'cdn');
      log.info({ jobId, urlCount: urls.length }, '[cdn] warming started');

      try {
        await Promise.all(
          urls.map((url) =>
            limit(async () => {
              const t = Date.now();
              try {
                const res = await axios.get(url, {
                  timeout: 30_000,
                  headers: {
                    'User-Agent': 'TradeAero-CacheWarmer/1.0',
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache',
                  },
                  maxRedirects: 5,
                  validateStatus: (s) => s < 500,
                });
                success++;
                log.debug({ url, status: res.status, durationMs: Date.now() - t }, '[cdn] warm OK');
              } catch (err) {
                failed++;
                log.warn({ url, err: (err as Error).message, durationMs: Date.now() - t }, '[cdn] warm failed');
              }
            })
          )
        );

        log.info({ jobId, success, failed }, '[cdn] warming complete');
        await markChannelDone(jobId, 'cdn', { urlsSuccess: success, urlsFailed: failed });
      } catch (err) {
        log.error({ err, jobId }, '[cdn] worker fatal error');
        await markChannelFailed(jobId, 'cdn', { urlsSuccess: success, urlsFailed: failed });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
