import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { loadConfig, getEnabledChannels } from './config';
import { fetchSitemapUrls } from './sitemap';
import { getQueue } from './queue';
import { saveJob, getJob, listJobs } from './jobCoordinator';
import type { WarmingJob, ChannelName } from './types';
import pino from 'pino';

export function createServer() {
  const config = loadConfig();
  const log = pino({ level: config.logging.level });
  const app = express();

  app.use(express.json());

  // ---------------------------------------------------------------------------
  // Auth middleware
  // ---------------------------------------------------------------------------
  function requireApiKey(req: Request, res: Response, next: NextFunction): void {
    const key = req.headers['x-api-key'];
    if (!key || key !== config.server.apiKey) {
      res.status(401).json({ error: 'Unauthorized — provide X-API-Key header' });
      return;
    }
    next();
  }

  app.use(requireApiKey);

  // ---------------------------------------------------------------------------
  // POST /jobs — enqueue a warming run
  // Body: { sitemapUrl?: string; urls?: string[] }
  // ---------------------------------------------------------------------------
  app.post('/jobs', async (req: Request, res: Response): Promise<void> => {
    const { sitemapUrl, urls: explicitUrls } = req.body as {
      sitemapUrl?: string;
      urls?: string[];
    };

    if (!sitemapUrl && (!explicitUrls || !explicitUrls.length)) {
      res.status(400).json({ error: 'Provide sitemapUrl or urls[]' });
      return;
    }

    let urls: string[] = explicitUrls ?? [];

    if (sitemapUrl) {
      try {
        const parsed = await fetchSitemapUrls(sitemapUrl);
        urls = [...new Set([...urls, ...parsed])];
      } catch (err) {
        log.warn({ err, sitemapUrl }, 'Failed to fetch sitemap');
        res.status(400).json({ error: `Failed to fetch sitemap: ${(err as Error).message}` });
        return;
      }
    }

    if (!urls.length) {
      res.status(400).json({ error: 'No URLs found in sitemap or urls[]' });
      return;
    }

    const channels = getEnabledChannels(config);
    if (!channels.length) {
      res.status(400).json({ error: 'No warming channels are enabled in config' });
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
      triggeredBy: 'api',
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

    // Enqueue one BullMQ job per channel (each job carries all URLs for that channel)
    for (const channel of channels) {
      const queue = getQueue(channel);
      await queue.add(jobId, { jobId, urls, channel });
      log.info({ jobId, channel, urlCount: urls.length }, 'Enqueued warming job');
    }

    res.status(202).json({ jobId, urlsFound: urls.length, channels });
  });

  // ---------------------------------------------------------------------------
  // GET /jobs/:id — job status
  // ---------------------------------------------------------------------------
  app.get('/jobs/:id', async (req: Request, res: Response): Promise<void> => {
    const job = await getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json(job);
  });

  // ---------------------------------------------------------------------------
  // GET /runs — paginated run history (from Redis)
  // Query: ?page=1&limit=20
  // ---------------------------------------------------------------------------
  app.get('/runs', async (req: Request, res: Response): Promise<void> => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10)));
    const { runs, total } = await listJobs(page, limit);
    res.json({ runs, total, page, limit });
  });

  // ---------------------------------------------------------------------------
  // DELETE /cache — manually purge specific URLs from CDN channels
  // Body: { urls: string[] }
  // ---------------------------------------------------------------------------
  app.delete('/cache', async (req: Request, res: Response): Promise<void> => {
    const { urls } = req.body as { urls?: string[] };
    if (!urls?.length) {
      res.status(400).json({ error: 'Provide urls[]' });
      return;
    }

    const jobId = crypto.randomUUID();
    const purgeChannels: ChannelName[] = [];
    if (config.cloudflare.enabled) purgeChannels.push('cloudflare');
    if (config.vercel.enabled)     purgeChannels.push('vercel');
    if (config.cdn.enabled)        purgeChannels.push('cdn');

    if (!purgeChannels.length) {
      res.status(400).json({ error: 'No cache channels enabled — enable cdn, cloudflare, or vercel' });
      return;
    }

    const job: WarmingJob = {
      jobId,
      urls,
      channels: purgeChannels,
      startedAt: new Date().toISOString(),
      status: 'running',
      triggeredBy: 'manual',
      progress: {},
    };

    for (const channel of purgeChannels) {
      job.progress[channel] = { status: 'pending', urlsTotal: urls.length, urlsSuccess: 0, urlsFailed: 0 };
      await getQueue(channel).add(jobId, { jobId, urls, channel });
    }

    await saveJob(job);

    res.status(202).json({ jobId, purged: urls.length, channels: purgeChannels });
  });

  // ---------------------------------------------------------------------------
  // Health check (no auth required)
  // ---------------------------------------------------------------------------
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  return app;
}
