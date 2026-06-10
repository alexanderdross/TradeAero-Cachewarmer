import axios from 'axios';
import type { ChannelResult } from './types';
import { SEQUENTIAL_CHANNEL_BUDGET_MS, createDeadline } from './budget';

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export interface TwitterConfig {
  bearerToken?: string;
  delayBetweenRequests?: number;
  /** Per-channel wall-clock budget (ms). Defaults to SEQUENTIAL_CHANNEL_BUDGET_MS. */
  budgetMs?: number;
}

/**
 * Warms Twitter/X card cache by hitting the public oEmbed endpoint.
 * This triggers Twitterbot to re-scrape twitter:card meta tags on the target page.
 * Bearer token is optional but improves reliability.
 */
export async function warmTwitter(urls: string[], config: TwitterConfig): Promise<ChannelResult> {
  const delay = config.delayBetweenRequests ?? 2_000;
  const overBudget = createDeadline(config.budgetMs ?? SEQUENTIAL_CHANNEL_BUDGET_MS);
  let success = 0, failed = 0;

  for (let i = 0; i < urls.length; i++) {
    if (overBudget()) { failed += urls.length - i; break; }
    const url = urls[i];
    try {
      const endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`;
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (compatible; CacheWarmer/1.0)',
      };
      if (config.bearerToken) {
        headers['Authorization'] = `Bearer ${config.bearerToken}`;
      }
      await axios.get(endpoint, {
        headers,
        timeout: 15_000,
        // 404 = URL has no tweet card yet, but scrape request was still sent
        validateStatus: (s) => s < 500,
      });
      success++;
    } catch {
      failed++;
    }
    if (i < urls.length - 1) await sleep(delay);
  }

  return { success, failed };
}
