import axios from 'axios';
import type { ChannelResult } from './types';

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export interface PinterestConfig {
  accessToken: string;
  delayBetweenRequests?: number;
}

/**
 * Warms Pinterest pin preview cache via the oEmbed API v5.
 * Triggers Pinterest to re-scrape OG/twitter:card meta tags on the target page,
 * refreshing the Pin preview card appearance.
 * Rate limit: 1,000 requests/hour per access token.
 */
export async function warmPinterest(urls: string[], config: PinterestConfig): Promise<ChannelResult> {
  const delay = config.delayBetweenRequests ?? 3_600;
  let success = 0, failed = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const endpoint = `https://api.pinterest.com/v5/oembed/?url=${encodeURIComponent(url)}&access_token=${config.accessToken}`;
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
