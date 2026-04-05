/**
 * LinkedIn Worker — refreshes LinkedIn link preview cards via the Post Inspector.
 *
 * Sends a POST to LinkedIn's internal post inspector endpoint using the li_at
 * session cookie for authentication. LinkedIn does not publish a public API
 * for this operation; this approach mirrors what the browser does at
 * linkedin.com/post-inspector.
 *
 * Rate: no official limit. Keep concurrency=1 and delayBetweenRequests≥5000ms
 * to avoid session suspension. li_at expires after ~1 year.
 *
 * WARNING: This uses a session cookie that grants full account access.
 *          Rotate it immediately if the account is compromised.
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

export function startLinkedinWorker(log: pino.Logger): Worker {
  const config = loadConfig();

  return new Worker<ChannelJobData>(
    'cachewarmer:linkedin',
    async (job: Job<ChannelJobData>) => {
      const { jobId, urls } = job.data;
      const delay = config.linkedin.delayBetweenRequests ?? 5_000;
      let success = 0;
      let failed = 0;

      await markChannelRunning(jobId, 'linkedin');
      log.info({ jobId, urlCount: urls.length, delayMs: delay }, '[linkedin] inspection started');

      try {
        for (const url of urls) {
          const t = Date.now();
          try {
            // LinkedIn's Post Inspector — mirrors browser behaviour
            await axios.get('https://www.linkedin.com/post-inspector/inspect/', {
              params: { url },
              headers: {
                Cookie: `li_at=${config.linkedin.sessionCookie}`,
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                Referer: 'https://www.linkedin.com/',
                'Accept-Language': 'en-US,en;q=0.9',
              },
              timeout: 20_000,
              maxRedirects: 5,
              validateStatus: (s) => s < 500,
            });
            success++;
            log.debug({ url, durationMs: Date.now() - t }, '[linkedin] inspect OK');
          } catch (err) {
            failed++;
            log.warn({ url, err: (err as Error).message }, '[linkedin] inspect failed');
          }

          if (url !== urls[urls.length - 1]) {
            await sleep(delay);
          }
        }

        log.info({ jobId, success, failed }, '[linkedin] inspection complete');
        await markChannelDone(jobId, 'linkedin', { urlsSuccess: success, urlsFailed: failed });
      } catch (err) {
        log.error({ err, jobId }, '[linkedin] worker fatal error');
        await markChannelFailed(jobId, 'linkedin', { urlsSuccess: success, urlsFailed: failed });
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 1 }
  );
}
