import axios from 'axios';
import type { ChannelResult } from './types';

const BATCH = 500;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function siteUrl(urls: string[]): string {
  try { const u = new URL(urls[0]); return `${u.protocol}//${u.hostname}`; }
  catch { return 'https://trade.aero'; }
}

export interface BingConfig {
  apiKey: string;
  dailyQuota?: number;
}

export async function warmBing(urls: string[], config: BingConfig): Promise<ChannelResult> {
  const toProcess = urls.slice(0, config.dailyQuota ?? 10_000);
  const site = siteUrl(toProcess);
  let success = 0, failed = 0;
  for (const batch of chunk(toProcess, BATCH)) {
    try {
      await axios.post(
        `https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch?apikey=${config.apiKey}`,
        { siteUrl: site, urlList: batch },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20_000 }
      );
      success += batch.length;
    } catch { failed += batch.length; }
  }
  return { success, failed };
}
