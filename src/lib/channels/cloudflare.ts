import axios from 'axios';
import pLimit from 'p-limit';
import type { ChannelResult } from './types';
import { WARM_CHANNEL_BUDGET_MS, createDeadline } from './budget';

const CF_BATCH = 30;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface CloudflareConfig {
  apiToken: string;
  zoneId: string;
  /** Per-channel wall-clock budget (ms). Defaults to WARM_CHANNEL_BUDGET_MS. */
  budgetMs?: number;
}

export async function warmCloudflare(urls: string[], config: CloudflareConfig): Promise<ChannelResult> {
  const overBudget = createDeadline(config.budgetMs ?? WARM_CHANNEL_BUDGET_MS);
  let success = 0, failed = 0;
  // Step 1: batch purge. Stop issuing purges once the budget is spent so the
  // re-warm step below still gets a chance to run within the deadline.
  for (const batch of chunk(urls, CF_BATCH)) {
    if (overBudget()) break;
    try {
      await axios.post(
        `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`,
        { files: batch },
        { headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' }, timeout: 15_000 }
      );
    } catch { /* log-and-continue */ }
  }
  // Step 2: re-warm
  const limit = pLimit(4);
  await Promise.all(urls.map((url) => limit(async () => {
    // Budget spent: drain the remainder as failed (no fetch) so partial
    // successes survive instead of being discarded by the deadline wrapper.
    if (overBudget()) { failed++; return; }
    try {
      await axios.get(url, { timeout: 30_000, headers: { 'Cache-Control': 'no-cache' }, validateStatus: (s) => s < 500 });
      success++;
    } catch { failed++; }
  })));
  return { success, failed };
}
