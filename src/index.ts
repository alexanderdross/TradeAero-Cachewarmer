import { loadConfig } from './config';
import { createServer } from './server';
import { startWorkers } from './workers';
import { startScheduler } from './scheduler';
import pino from 'pino';

async function main() {
  const config = loadConfig();
  const log = pino({
    level: config.logging.level,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });

  log.info('TradeAero CacheWarmer starting…');

  // Start all enabled BullMQ workers
  startWorkers(log);

  // Start built-in cron scheduler
  startScheduler(log);

  // Start HTTP API (for manual triggers and status checks)
  const app = createServer();
  const port = config.server.port ?? 3001;
  app.listen(port, () => {
    log.info({ port }, `CacheWarmer HTTP API listening on :${port}`);
  });
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
