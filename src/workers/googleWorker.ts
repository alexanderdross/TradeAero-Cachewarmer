/**
 * Google Worker — notifies Googlebot of URL updates via the Indexing API.
 *
 * Sends URL_UPDATED notifications to indexing.googleapis.com using a service
 * account JWT for authentication. This hints Googlebot to crawl/recrawl the URL
 * as soon as possible — it does not guarantee immediate indexing.
 *
 * Quota: 200 URL notifications/day per Search Console property.
 * This quota is shared with TradeAero-Indexing (GOOGLE_SERVICE_ACCOUNT_JSON).
 * If TradeAero-Indexing already handles Google indexing, disable this channel.
 *
 * Setup: Cloud Console → Enable "Web Search Indexing API" → Service Account →
 *        Download JSON key → add SA email as Owner in Search Console.
 */
import { Worker, Job } from 'bullmq';
import { GoogleAuth } from 'google-auth-library';
import pino from 'pino';
import { getRedisConnection } from '../queue';
import { loadConfig } from '../config';
import { markChannelRunning, markChannelDone, markChannelFailed } from '../jobCoordinator';
import type { ChannelJobData } from '../types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startGoogleWorker(log: pino.Logger): Worker {
  const config = loadConfig();

  return new Worker<ChannelJobData>(
    'cachewarmer:google',
    async (job: Job<ChannelJobData>) => {
      const { jobId, urls } = job.data;
      let success = 0;
      let failed = 0;

      await markChannelRunning(jobId, 'google');
      log.info({ jobId, urlCount: urls.length }, '[google] indexing notifications started');

      let credentials: Record<string, unknown>;
      try {
        credentials = JSON.parse(config.google.serviceAccountJson) as Record<string, unknown>;
      } catch {
        log.error({ jobId }, '[google] invalid serviceAccountJson — not valid JSON');
        await markChannelFailed(jobId, 'google', { urlsSuccess: 0, urlsFailed: urls.length });
        return;
      }

      const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/indexing'],
      });

      const authClient = await auth.getClient();
      const INDEXING_API = 'https://indexing.googleapis.com/v3/urlNotifications:publish';

      try {
        // Respect the daily quota — warn when approaching limit
        const quota = config.google.dailyQuota ?? 200;
        const urlsToProcess = urls.slice(0, quota);

        if (urls.length > quota) {
          log.warn(
            { jobId, total: urls.length, quota },
            '[google] URL count exceeds daily quota — truncating'
          );
        }

        for (const url of urlsToProcess) {
          const t = Date.now();
          try {
            await authClient.request({
              url: INDEXING_API,
              method: 'POST',
              data: { url, type: 'URL_UPDATED' },
            });
            success++;
            log.debug({ url, durationMs: Date.now() - t }, '[google] URL_UPDATED OK');
          } catch (err) {
            failed++;
            const status = (err as { code?: number }).code;
            log.warn({ url, status, err: (err as Error).message }, '[google] URL_UPDATED failed');
            // 429 Too Many Requests — back off 60s
            if (status === 429) await sleep(60_000);
            else await sleep(500);
            continue;
          }
          // ~3 req/s to stay well within the quota ceiling
          await sleep(350);
        }

        log.info({ jobId, success, failed }, '[google] indexing notifications complete');
        await markChannelDone(jobId, 'google', { urlsSuccess: success, urlsFailed: failed });
      } catch (err) {
        log.error({ err, jobId }, '[google] worker fatal error');
        await markChannelFailed(jobId, 'google', { urlsSuccess: success, urlsFailed: failed });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
