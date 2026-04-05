import axios from 'axios';
import pLimit from 'p-limit';
import type { ChannelResult } from './types';

export interface CdnConfig {
  concurrency?: number;
}

export async function warmCdn(urls: string[], config: CdnConfig): Promise<ChannelResult> {
  const limit = pLimit(config.concurrency ?? 3);
  let success = 0, failed = 0;
  await Promise.all(urls.map((url) => limit(async () => {
    try {
      await axios.get(url, {
        timeout: 30_000,
        headers: { 'User-Agent': 'TradeAero-CacheWarmer/1.0', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        maxRedirects: 5,
        validateStatus: (s) => s < 500,
      });
      success++;
    } catch { failed++; }
  })));
  return { success, failed };
}
