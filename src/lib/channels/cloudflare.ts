import axios from 'axios';
import pLimit from 'p-limit';
import type { ChannelResult } from './types';

const CF_BATCH = 30;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export interface CloudflareConfig {
  apiToken: string;
  zoneId: string;
}

export async function warmCloudflare(urls: string[], config: CloudflareConfig): Promise<ChannelResult> {
  let success = 0, failed = 0;
  // Step 1: batch purge
  for (const batch of chunk(urls, CF_BATCH)) {
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
    try {
      await axios.get(url, { timeout: 30_000, headers: { 'Cache-Control': 'no-cache' }, validateStatus: (s) => s < 500 });
      success++;
    } catch { failed++; }
  })));
  return { success, failed };
}
