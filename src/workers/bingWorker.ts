/**
 * Bing Worker — submits URLs to Bing for crawling via the Webmaster API.
 *
 * Uses the SubmitUrlbatch endpoint which accepts up to 500 URLs per request.
 * Requires a verified website in Bing Webmaster Tools and a generated API key.
 *
 * Quota: 10,000 URLs/day (extendable via Bing Webmaster Tools on request).
 * Setup: bing.com/webmasters → verify site → Settings → API Access → Generate key.
 */
import { Worker, Job } from 'bullmq';
import axios from 'axios';
import pino from 'pino';
import { getRedisConnection } from '../queue';
import { loadConfig } from '../config';
import { markChannelRunning, markChannelDone, markChannelFailed } from '../jobCoordinator';
import type { ChannelJobData } from '../types';

const BING_BATCH_SIZE = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function siteUrlFromUrls(urls: string[]): string {
  try {
    const u = new URL(urls[0]);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return 'https://trade.aero';
  }
}

export function startBingWorker(log: pino.Logger): Worker {
  const config = loadConfig();

  return new Worker<ChannelJobData>(
    'cachewarmer:bing',
    async (job: Job<ChannelJobData>) => {
      const { jobId, urls } = job.data;
      let success = 0;
      let failed = 0;

      await markChannelRunning(jobId, 'bing');
      log.info({ jobId, urlCount: urls.length }, '[bing] submission started');

      const siteUrl = siteUrlFromUrls(urls);
      const batches = chunk(urls, BING_BATCH_SIZE);

      try {
        for (const batch of batches) {
          try {
            await axios.post(
              `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${config.bing.apiKey}`,
              { siteUrl, urlList: batch },
              {
                headers: { 'Content-Type': 'application/json' },
                timeout: 20_000,
              }
            );
            success += batch.length;
            log.debug({ batchSize: batch.length }, '[bing] batch submitted OK');
          } catch (err) {
            failed += batch.length;
            const status = axios.isAxiosError(err) ? err.response?.status : undefined;
            log.warn(
              { batchSize: batch.length, status, err: (err as Error).message },
              '[bing] batch submission failed'
            );
          }
        }

        log.info({ jobId, success, failed }, '[bing] submission complete');
        await markChannelDone(jobId, 'bing', { urlsSuccess: success, urlsFailed: failed });
      } catch (err) {
        log.error({ err, jobId }, '[bing] worker fatal error');
        await markChannelFailed(jobId, 'bing', { urlsSuccess: success, urlsFailed: failed });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
