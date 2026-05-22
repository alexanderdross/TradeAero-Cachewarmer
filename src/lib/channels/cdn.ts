import axios from 'axios';
import pLimit from 'p-limit';
import type { ChannelResult } from './types';
import { isAllowedUrl, MAX_REDIRECTS } from '../url-guard';

export interface CdnConfig {
  concurrency?: number;
}

export async function warmCdn(urls: string[], config: CdnConfig): Promise<ChannelResult> {
  const limit = pLimit(config.concurrency ?? 3);
  let success = 0, failed = 0;
  await Promise.all(urls.map((url) => limit(async () => {
    // SSRF guard: urls can come straight from the POST /api/jobs body.
    if (!isAllowedUrl(url)) { failed++; return; }
    try {
      await axios.get(url, {
        timeout: 30_000,
        headers: { 'User-Agent': 'TradeAero-CacheWarmer/1.0', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        maxRedirects: MAX_REDIRECTS,
        validateStatus: (s) => s < 500,
      });
      success++;
    } catch { failed++; }
  })));
  return { success, failed };
}
