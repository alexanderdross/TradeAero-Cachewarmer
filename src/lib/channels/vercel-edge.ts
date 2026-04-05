import axios from 'axios';
import pLimit from 'p-limit';
import type { ChannelResult } from './types';

export interface VercelEdgeConfig {
  apiToken?: string;
  teamId?: string;
}

export async function warmVercelEdge(urls: string[], _config: VercelEdgeConfig): Promise<ChannelResult> {
  // Re-warm via HTTP GET with no-cache — forces Vercel edge to fetch fresh from origin
  const limit = pLimit(4);
  let success = 0, failed = 0;
  await Promise.all(urls.map((url) => limit(async () => {
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
