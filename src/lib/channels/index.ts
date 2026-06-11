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
import { warmTwitter } from './twitter';
import { warmPinterest } from './pinterest';

export type { ChannelResult };

/**
 * Channel tiers.
 *
 * WARM — real edge/CDN cache warming. Fast, no external rate limits. This is
 *   what "warming" actually means and is what judges a job's success.
 * DISTRIBUTION — social + search-engine submission. Slow (mandatory per-URL
 *   sleeps: pinterest 4s, twitter 2.4s, …), externally rate-limited, and
 *   best-effort. It must NEVER gate a job's success, and it is NOT run on
 *   per-listing (targeted) jobs — firing it on every publish hammered those
 *   APIs into 429s and timed each job out at the 250s warm budget (the burst
 *   that produced the all-red "0/14" run history). Search submission
 *   (google/bing/indexnow) is owned by the dedicated indexing service, so
 *   those stay disabled here.
 */
export const WARM_CHANNELS: readonly ChannelName[] = ['cdn', 'cloudflare', 'vercel'];
export const DISTRIBUTION_CHANNELS: readonly ChannelName[] = [
  'facebook', 'linkedin', 'google', 'bing', 'indexnow', 'twitter', 'pinterest',
];

export function isWarmChannel(name: string): boolean {
  return (WARM_CHANNELS as readonly string[]).includes(name);
}

export interface RunChannelsOptions {
  /** Restrict to this set of channels (e.g. WARM_CHANNELS for targeted
   *  per-listing jobs). When omitted, every enabled channel runs. */
  only?: readonly ChannelName[];
  /** Per-channel wall-clock budget. A channel that doesn't settle in time is
   *  recorded as failed (timedOut) rather than discarding the whole run's
   *  results — so one slow channel can't turn a successful warm into 0/total. */
  deadlineMs?: number;
}

/** Resolve to the channel's result, or a timed-out failure after `ms`. The
 *  losing fetch keeps running in the background but the result is already
 *  recorded. */
function withChannelDeadline(
  p: Promise<ChannelResult>,
  ms: number,
  total: number,
): Promise<ChannelResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ChannelResult>((resolve) => {
    timer = setTimeout(() => resolve({ success: 0, failed: total, timedOut: true }), ms);
  });
  return Promise.race([
    p.finally(() => { if (timer) clearTimeout(timer); }),
    deadline,
  ]);
}

export async function runAllChannels(
  urls: string[],
  channels: Partial<Record<ChannelName, ChannelEntry>>,
  opts: RunChannelsOptions = {},
): Promise<Record<string, ChannelResult>> {
  const onlySet = opts.only ? new Set<string>(opts.only) : null;
  const want = (name: ChannelName) =>
    Boolean(channels[name]?.enabled) && (!onlySet || onlySet.has(name));

  const tasks: Array<{ name: string; promise: Promise<ChannelResult> }> = [];

  // Warm channels self-limit to (a little under) the per-channel deadline so
  // they return real partial counts before `withChannelDeadline` would fire
  // and discard them as 0/total. Leave headroom for an in-flight 30s fetch to
  // settle after the budget elapses. When no deadline is set (the cron's small
  // cursor-chunked batches) the channel falls back to its generous default.
  const warmBudget = (cfg: Record<string, any>): Record<string, any> =>
    opts.deadlineMs
      ? { ...cfg, budgetMs: Math.max(1_000, opts.deadlineMs - 35_000) }
      : cfg;

  if (want('cdn')) tasks.push({ name: 'cdn', promise: warmCdn(urls, warmBudget(channels.cdn!.config)) });
  if (want('cloudflare')) tasks.push({ name: 'cloudflare', promise: warmCloudflare(urls, warmBudget(channels.cloudflare!.config) as any) });
  if (want('vercel')) tasks.push({ name: 'vercel', promise: warmVercelEdge(urls, warmBudget(channels.vercel!.config)) });
  if (want('facebook')) tasks.push({ name: 'facebook', promise: warmFacebook(urls, channels.facebook!.config as any) });
  if (want('linkedin')) tasks.push({ name: 'linkedin', promise: warmLinkedin(urls, channels.linkedin!.config as any) });
  if (want('google')) tasks.push({ name: 'google', promise: warmGoogle(urls, channels.google!.config as any) });
  if (want('bing')) tasks.push({ name: 'bing', promise: warmBing(urls, channels.bing!.config as any) });
  if (want('indexnow')) tasks.push({ name: 'indexnow', promise: warmIndexNow(urls, channels.indexnow!.config as any) });
  if (want('twitter')) tasks.push({ name: 'twitter', promise: warmTwitter(urls, channels.twitter!.config as any) });
  if (want('pinterest')) tasks.push({ name: 'pinterest', promise: warmPinterest(urls, channels.pinterest!.config as any) });

  const guarded = opts.deadlineMs
    ? tasks.map((t) => withChannelDeadline(t.promise, opts.deadlineMs!, urls.length))
    : tasks.map((t) => t.promise);

  const results = await Promise.allSettled(guarded);
  const out: Record<string, ChannelResult> = {};
  for (let i = 0; i < tasks.length; i++) {
    const r = results[i];
    out[tasks[i].name] = r.status === 'fulfilled' ? r.value : { success: 0, failed: urls.length };
  }
  return out;
}
