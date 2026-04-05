import type { ChannelName, ChannelEntry } from '../config';
import type { ChannelResult } from './types';
import { warmCdn } from './cdn';
import { warmCloudflare } from './cloudflare';
import { warmVercelEdge } from './vercel-edge';
import { warmFacebook } from './facebook';
import { warmLinkedin } from './linkedin';
import { warmGoogle } from './google';
import { warmBing } from './bing';
import { warmIndexNow } from './indexnow';

export type { ChannelResult };

export async function runAllChannels(
  urls: string[],
  channels: Partial<Record<ChannelName, ChannelEntry>>
): Promise<Record<string, ChannelResult>> {
  const tasks: Array<{ name: string; promise: Promise<ChannelResult> }> = [];

  const ch = (name: ChannelName) => channels[name];

  if (ch('cdn')?.enabled) tasks.push({ name: 'cdn', promise: warmCdn(urls, ch('cdn')!.config) });
  if (ch('cloudflare')?.enabled) tasks.push({ name: 'cloudflare', promise: warmCloudflare(urls, ch('cloudflare')!.config as any) });
  if (ch('vercel')?.enabled) tasks.push({ name: 'vercel', promise: warmVercelEdge(urls, ch('vercel')!.config) });
  if (ch('facebook')?.enabled) tasks.push({ name: 'facebook', promise: warmFacebook(urls, ch('facebook')!.config as any) });
  if (ch('linkedin')?.enabled) tasks.push({ name: 'linkedin', promise: warmLinkedin(urls, ch('linkedin')!.config as any) });
  if (ch('google')?.enabled) tasks.push({ name: 'google', promise: warmGoogle(urls, ch('google')!.config as any) });
  if (ch('bing')?.enabled) tasks.push({ name: 'bing', promise: warmBing(urls, ch('bing')!.config as any) });
  if (ch('indexnow')?.enabled) tasks.push({ name: 'indexnow', promise: warmIndexNow(urls, ch('indexnow')!.config as any) });

  const results = await Promise.allSettled(tasks.map((t) => t.promise));
  const out: Record<string, ChannelResult> = {};
  for (let i = 0; i < tasks.length; i++) {
    const r = results[i];
    out[tasks[i].name] = r.status === 'fulfilled' ? r.value : { success: 0, failed: urls.length };
  }
  return out;
}
