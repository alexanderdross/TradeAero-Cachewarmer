import axios from 'axios';
import type { ChannelResult } from './types';

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export interface PinterestConfig {
  accessToken?: string;        // Optional — public endpoint works without it (lower scrape reliability)
  delayBetweenRequests?: number;
}

/**
 * Warms Pinterest pin preview cache via the oEmbed API v5.
 * Triggers Pinterest to re-scrape OG/twitter:card meta tags on the target page,
 * refreshing the Pin preview card appearance.
 * Rate limit: 1,000 requests/hour per access token; no hard limit on public endpoint.
 * accessToken is optional — the public endpoint works without auth but may be less reliable.
 */
export async function warmPinterest(urls: string[], config: PinterestConfig): Promise<ChannelResult> {
  const delay = config.delayBetweenRequests ?? 3_600;
  let success = 0, failed = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const base = `https://api.pinterest.com/v5/oembed/?url=${encodeURIComponent(url)}`;
      const endpoint = config.accessToken ? `${base}&access_token=${config.accessToken}` : base;
      await axios.get(endpoint, {
        timeout: 15_000,
        validateStatus: (s) => s < 500,
        headers: {
          'User-Agent': 'CacheWarmer/1.0',
        },
      });
      success++;
    } catch {
      failed++;
    }
    if (i < urls.length - 1) await sleep(delay);
  }

  return { success, failed };
}
