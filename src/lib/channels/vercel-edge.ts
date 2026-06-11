import axios from 'axios';
import pLimit from 'p-limit';
import type { ChannelResult } from './types';
import { WARM_CHANNEL_BUDGET_MS, createDeadline } from './budget';

export interface VercelEdgeConfig {
  apiToken?: string;
  teamId?: string;
  /** Per-channel wall-clock budget (ms). Defaults to WARM_CHANNEL_BUDGET_MS. */
  budgetMs?: number;
}

export async function warmVercelEdge(urls: string[], config: VercelEdgeConfig): Promise<ChannelResult> {
  // Re-warm via HTTP GET with no-cache — forces Vercel edge to fetch fresh from origin
  const limit = pLimit(4);
  const overBudget = createDeadline(config.budgetMs ?? WARM_CHANNEL_BUDGET_MS);
  let success = 0, failed = 0;
  await Promise.all(urls.map((url) => limit(async () => {
    // Budget spent: drain the remainder as failed (no fetch) so partial
    // successes survive instead of being discarded by the deadline wrapper.
    if (overBudget()) { failed++; return; }
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
