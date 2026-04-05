/**
 * Built-in scheduler — runs warming jobs on the server via node-cron.
 *
 * This is the primary way to schedule the CacheWarmer. No external HTTP call,
 * no GitHub Actions dependency — the service triggers itself based on the
 * `schedule.cron` expression in config.yaml.
 *
 * Default: twice daily at 06:00 and 18:00 server time ("0 6,18 * * *").
 *
 * The workflow in .github/workflows/warm-cache.yml exists for:
 *   - Manual one-click runs from the GitHub Actions UI (workflow_dispatch)
 *   - Triggering the service from a self-hosted runner on the same server
 */
import cron from 'node-cron';
import crypto from 'crypto';
import pino from 'pino';
import { loadConfig, getEnabledChannels } from './config';
import { fetchSitemapUrls } from './sitemap';
import { getQueue } from './queue';
import { saveJob } from './jobCoordinator';
import type { WarmingJob } from './types';

export function startScheduler(log: pino.Logger): void {
  const config = loadConfig();

  if (!config.schedule?.enabled) {
    log.info('[scheduler] disabled in config');
    return;
  }

  const { cron: expression, sitemapUrl } = config.schedule;

  if (!cron.validate(expression)) {
    log.error({ expression }, '[scheduler] invalid cron expression — scheduler not started');
    return;
  }

  log.info({ expression, sitemapUrl }, '[scheduler] scheduled warming job registered');

  cron.schedule(expression, async () => {
    log.info({ sitemapUrl }, '[scheduler] warming run triggered by cron');

    try {
      const urls = await fetchSitemapUrls(sitemapUrl);
      if (!urls.length) {
        log.warn({ sitemapUrl }, '[scheduler] sitemap returned 0 URLs — skipping run');
        return;
      }

      const channels = getEnabledChannels(config);
      if (!channels.length) {
        log.warn('[scheduler] no channels enabled — skipping run');
        return;
      }

      const jobId = crypto.randomUUID();
      const job: WarmingJob = {
        jobId,
        sitemapUrl,
        urls,
        channels,
        startedAt: new Date().toISOString(),
        status: 'running',
        triggeredBy: 'manual',  // 'manual' = server-initiated (not via external API)
        progress: {},
      };

      for (const channel of channels) {
        job.progress[channel] = {
          status: 'pending',
          urlsTotal: urls.length,
          urlsSuccess: 0,
          urlsFailed: 0,
        };
      }

      await saveJob(job);

      for (const channel of channels) {
        await getQueue(channel).add(jobId, { jobId, urls, channel });
      }

      log.info({ jobId, urlCount: urls.length, channels }, '[scheduler] warming job enqueued');
    } catch (err) {
      log.error({ err }, '[scheduler] failed to enqueue warming job');
    }
  });
}
