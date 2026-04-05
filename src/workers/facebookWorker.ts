/**
 * Facebook Worker — refreshes the Facebook Open Graph scraper cache for each URL.
 *
 * Uses the Graph API scrape endpoint with an App Access Token (appId|appSecret).
 * This forces Facebook to re-fetch the page's OG tags, updating link previews
 * in Facebook posts, Messenger shares, and WhatsApp.
 *
 * Rate limit: 200 calls/hour per App. The worker enforces a configurable
 * per-second rate limit (default: 10/s with burst). The hourly hard cap
 * is approached after ~7 minutes at max rate — size your URL batches accordingly
 * or set rateLimitPerSecond lower (e.g. 2) for large sitemaps.
 */
import { Worker, Job } from 'bullmq';
import axios from 'axios';
import pino from 'pino';
import { getRedisConnection } from '../queue';
import { loadConfig } from '../config';
import { markChannelRunning, markChannelDone, markChannelFailed } from '../jobCoordinator';
import type { ChannelJobData } from '../types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startFacebookWorker(log: pino.Logger): Worker {
  const config = loadConfig();

  return new Worker<ChannelJobData>(
    'cachewarmer:facebook',
    async (job: Job<ChannelJobData>) => {
      const { jobId, urls } = job.data;
      const accessToken = `${config.facebook.appId}|${config.facebook.appSecret}`;
      const delayMs = config.facebook.rateLimitPerSecond > 0
        ? Math.ceil(1000 / config.facebook.rateLimitPerSecond)
        : 200;

      let success = 0;
      let failed = 0;

      await markChannelRunning(jobId, 'facebook');
      log.info({ jobId, urlCount: urls.length, delayMs }, '[facebook] scrape started');

      try {
        for (const url of urls) {
          const t = Date.now();
          try {
            await axios.post(
              'https://graph.facebook.com/',
              null,
              {
                params: { id: url, scrape: 'true', access_token: accessToken },
                timeout: 15_000,
              }
            );
            success++;
            log.debug({ url, durationMs: Date.now() - t }, '[facebook] scrape OK');
          } catch (err) {
            failed++;
            const status = axios.isAxiosError(err) ? err.response?.status : undefined;
            log.warn({ url, status, err: (err as Error).message }, '[facebook] scrape failed');
            // On 400 (rate limit), back off for 10s
            if (status === 400 || status === 429) {
              await sleep(10_000);
              continue;
            }
          }
          await sleep(delayMs);
        }

        log.info({ jobId, success, failed }, '[facebook] scrape complete');
        await markChannelDone(jobId, 'facebook', { urlsSuccess: success, urlsFailed: failed });
      } catch (err) {
        log.error({ err, jobId }, '[facebook] worker fatal error');
        await markChannelFailed(jobId, 'facebook', { urlsSuccess: success, urlsFailed: failed });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
