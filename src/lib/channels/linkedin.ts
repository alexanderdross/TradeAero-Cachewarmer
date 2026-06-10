import axios from 'axios';
import type { ChannelResult } from './types';
import { SEQUENTIAL_CHANNEL_BUDGET_MS, createDeadline } from './budget';

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export interface LinkedinConfig {
  sessionCookie: string;
  delayBetweenRequests?: number;
  /** Per-channel wall-clock budget (ms). Defaults to SEQUENTIAL_CHANNEL_BUDGET_MS. */
  budgetMs?: number;
}

export async function warmLinkedin(urls: string[], config: LinkedinConfig): Promise<ChannelResult> {
  const delay = config.delayBetweenRequests ?? 5_000;
  // Cap at 40 URLs as a coarse ceiling; the wall-clock budget below is the
  // real guard against a hung upstream eating the whole warm window.
  const toProcess = urls.slice(0, 40);
  const overBudget = createDeadline(config.budgetMs ?? SEQUENTIAL_CHANNEL_BUDGET_MS);
  let success = 0, failed = 0;
  for (let i = 0; i < toProcess.length; i++) {
    // Stop issuing new requests once the budget is spent; count the rest as
    // failed (not warmed) so the totals stay honest.
    if (overBudget()) { failed += toProcess.length - i; break; }
    const url = toProcess[i];
    try {
      await axios.get('https://www.linkedin.com/post-inspector/inspect/', {
        params: { url },
        headers: {
          Cookie: `li_at=${config.sessionCookie}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Referer: 'https://www.linkedin.com/',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 20_000,
        maxRedirects: 5,
        validateStatus: (s) => s < 500,
      });
      success++;
    } catch { failed++; }
    if (i < toProcess.length - 1) await sleep(delay);
  }
  return { success, failed };
}
