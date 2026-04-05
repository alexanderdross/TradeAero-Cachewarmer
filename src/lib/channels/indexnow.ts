import axios from 'axios';
import type { ChannelResult } from './types';

const BATCH = 10_000;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function hostname(urls: string[]): string {
  try { return new URL(urls[0]).hostname; }
  catch { return 'trade.aero'; }
}

export interface IndexNowConfig {
  key: string;
  keyLocation?: string;
}

export async function warmIndexNow(urls: string[], config: IndexNowConfig): Promise<ChannelResult> {
  const host = hostname(urls);
  let success = 0, failed = 0;
  for (const batch of chunk(urls, BATCH)) {
    try {
      await axios.post(
        'https://api.indexnow.org/indexnow',
        { host, key: config.key, keyLocation: config.keyLocation, urlList: batch },
        { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 20_000, validateStatus: (s) => s === 200 || s === 202 }
      );
      success += batch.length;
    } catch { failed += batch.length; }
  }
  return { success, failed };
}
