import pino from 'pino';
import { loadConfig } from '../config';
import { startCdnWorker } from './cdnWorker';
import { startCloudflareWorker } from './cloudflareWorker';
import { startVercelWorker } from './vercelWorker';
import { startFacebookWorker } from './facebookWorker';
import { startLinkedinWorker } from './linkedinWorker';
import { startGoogleWorker } from './googleWorker';
import { startBingWorker } from './bingWorker';
import { startIndexNowWorker } from './indexNowWorker';

export function startWorkers(log: pino.Logger): void {
  const config = loadConfig();
  const started: string[] = [];

  if (config.cdn.enabled) {
    startCdnWorker(log);
    started.push('cdn');
  }
  if (config.cloudflare.enabled) {
    startCloudflareWorker(log);
    started.push('cloudflare');
  }
  if (config.vercel.enabled) {
    startVercelWorker(log);
    started.push('vercel');
  }
  if (config.facebook.enabled) {
    startFacebookWorker(log);
    started.push('facebook');
  }
  if (config.linkedin.enabled) {
    startLinkedinWorker(log);
    started.push('linkedin');
  }
  if (config.google.enabled) {
    startGoogleWorker(log);
    started.push('google');
  }
  if (config.bing.enabled) {
    startBingWorker(log);
    started.push('bing');
  }
  if (config.indexNow.enabled) {
    startIndexNowWorker(log);
    started.push('indexNow');
  }

  if (started.length > 0) {
    log.info({ workers: started }, `Started ${started.length} warming worker(s)`);
  } else {
    log.warn('No warming channels are enabled. Enable at least one channel in config.yaml.');
  }
}
