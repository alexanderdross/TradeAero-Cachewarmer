import { GoogleAuth } from 'google-auth-library';
import type { ChannelResult } from './types';

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

export interface GoogleConfig {
  serviceAccountJson: string;
  dailyQuota?: number;
}

export async function warmGoogle(urls: string[], config: GoogleConfig): Promise<ChannelResult> {
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(config.serviceAccountJson) as Record<string, unknown>;
  } catch {
    throw new Error('[google] serviceAccountJson is not valid JSON');
  }

  const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/indexing'] });
  const authClient = await auth.getClient();
  const INDEXING_API = 'https://indexing.googleapis.com/v3/urlNotifications:publish';

  const quota = config.dailyQuota ?? 200;
  const toProcess = urls.slice(0, quota);
  let success = 0, failed = 0;

  for (const url of toProcess) {
    try {
      await authClient.request({ url: INDEXING_API, method: 'POST', data: { url, type: 'URL_UPDATED' } });
      success++;
    } catch (err) {
      failed++;
      if ((err as { code?: number }).code === 429) await sleep(60_000);
      else await sleep(500);
    }
    await sleep(350);
  }
  return { success, failed };
}
