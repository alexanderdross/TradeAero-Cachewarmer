import axios from 'axios';
import type { ChannelResult } from './types';

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export interface FacebookConfig {
  appId: string;
  appSecret: string;
  rateLimitPerSecond?: number;
}

export async function warmFacebook(urls: string[], config: FacebookConfig): Promise<ChannelResult> {
  const accessToken = `${config.appId}|${config.appSecret}`;
  const delayMs = config.rateLimitPerSecond && config.rateLimitPerSecond > 0
    ? Math.ceil(1000 / config.rateLimitPerSecond)
    : 200;
  // Respect hourly quota: cap at 200 URLs
  const toProcess = urls.slice(0, 200);
  let success = 0, failed = 0;
  for (const url of toProcess) {
    try {
      await axios.post('https://graph.facebook.com/', null, {
        params: { id: url, scrape: 'true', access_token: accessToken },
        timeout: 15_000,
      });
      success++;
    } catch (err) {
      failed++;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 400 || status === 429) await sleep(10_000);
    }
    await sleep(delayMs);
  }
  return { success, failed };
}
