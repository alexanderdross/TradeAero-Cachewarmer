/**
 * IndexNow Worker — submits URLs to the IndexNow protocol endpoint.
 *
 * A single POST to api.indexnow.org simultaneously notifies:
 *   Bing, Yandex, Seznam, Naver
 *
 * Supports up to 10,000 URLs per batch. The key file must be hosted at
 * keyLocation (e.g. https://trade.aero/{key}.txt) containing only the key.
 *
 * Reuse the same key as TradeAero-Indexing (INDEXNOW_API_KEY env var).
 * Duplicate submissions are idempotent — no harm done.
 */
import { Worker, Job } from 'bullmq';
import axios from 'axios';
import pino from 'pino';
import { getRedisConnection } from '../queue';
import { loadConfig } from '../config';
import { markChannelRunning, markChannelDone, markChannelFailed } from '../jobCoordinator';
import type { ChannelJobData } from '../types';

const INDEXNOW_BATCH_SIZE = 10_000;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function hostFromUrls(urls: string[]): string {
  try {
    return new URL(urls[0]).hostname;
  } catch {
    return 'trade.aero';
  }
}

export function startIndexNowWorker(log: pino.Logger): Worker {
  const config = loadConfig();

  return new Worker<ChannelJobData>(
    'cachewarmer:indexNow',
    async (job: Job<ChannelJobData>) => {
      const { jobId, urls } = job.data;
      let success = 0;
      let failed = 0;

      await markChannelRunning(jobId, 'indexNow');
      log.info({ jobId, urlCount: urls.length }, '[indexNow] submission started');

      const host = hostFromUrls(urls);
      const batches = chunk(urls, INDEXNOW_BATCH_SIZE);

      try {
        for (const batch of batches) {
          try {
            await axios.post(
              'https://api.indexnow.org/indexnow',
              {
                host,
                key: config.indexNow.key,
                keyLocation: config.indexNow.keyLocation,
                urlList: batch,
              },
              {
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                timeout: 20_000,
                // IndexNow returns 200 or 202 on success
                validateStatus: (s) => s === 200 || s === 202,
              }
            );
            success += batch.length;
            log.debug({ batchSize: batch.length }, '[indexNow] batch submitted OK');
          } catch (err) {
            failed += batch.length;
            const status = axios.isAxiosError(err) ? err.response?.status : undefined;
            log.warn(
              { batchSize: batch.length, status, err: (err as Error).message },
              '[indexNow] batch submission failed'
            );
          }
        }

        log.info({ jobId, success, failed }, '[indexNow] submission complete');
        await markChannelDone(jobId, 'indexNow', { urlsSuccess: success, urlsFailed: failed });
      } catch (err) {
        log.error({ err, jobId }, '[indexNow] worker fatal error');
        await markChannelFailed(jobId, 'indexNow', { urlsSuccess: success, urlsFailed: failed });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
