import axios from 'axios';
import pLimit from 'p-limit';
import type { ChannelResult } from './types';
import { isAllowedUrl, MAX_REDIRECTS } from '../url-guard';
import { WARM_CHANNEL_BUDGET_MS, createDeadline } from './budget';

export interface CdnConfig {
  concurrency?: number;
  /** Per-channel wall-clock budget (ms). Defaults to WARM_CHANNEL_BUDGET_MS. */
  budgetMs?: number;
}

export async function warmCdn(urls: string[], config: CdnConfig): Promise<ChannelResult> {
  const limit = pLimit(config.concurrency ?? 3);
  const overBudget = createDeadline(config.budgetMs ?? WARM_CHANNEL_BUDGET_MS);
  let success = 0, failed = 0;
  await Promise.all(urls.map((url) => limit(async () => {
    // Once the budget is spent, drain the rest as failed without fetching, so
    // the channel returns real partial counts rather than having the
    // runAllChannels deadline wrapper discard them as a blanket 0/total.
    if (overBudget()) { failed++; return; }
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
