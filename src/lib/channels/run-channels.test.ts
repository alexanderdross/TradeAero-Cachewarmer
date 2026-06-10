import { describe, it, expect, vi } from 'vitest';

// Mock the channel implementations so the test never hits external APIs.
// pinterest never settles, to exercise the per-channel deadline.
vi.mock('./cloudflare', () => ({ warmCloudflare: vi.fn(async () => ({ success: 3, failed: 0 })) }));
vi.mock('./vercel-edge', () => ({ warmVercelEdge: vi.fn(async () => ({ success: 3, failed: 0 })) }));
vi.mock('./twitter', () => ({ warmTwitter: vi.fn(async () => ({ success: 3, failed: 0 })) }));
vi.mock('./pinterest', () => ({ warmPinterest: vi.fn(() => new Promise<never>(() => {})) }));

import { runAllChannels, WARM_CHANNELS, isWarmChannel } from './index';
import type { ChannelEntry, ChannelName } from '../config';

const urls = ['https://trade.aero/a', 'https://trade.aero/b', 'https://trade.aero/c'];
const cfg: Partial<Record<ChannelName, ChannelEntry>> = {
  cloudflare: { enabled: true, config: {} },
  vercel: { enabled: true, config: {} },
  twitter: { enabled: true, config: {} },
  pinterest: { enabled: true, config: {} },
};

describe('runAllChannels', () => {
  it('only: WARM_CHANNELS runs just the warm tier — no social channels', async () => {
    const res = await runAllChannels(urls, cfg, { only: WARM_CHANNELS });
    expect(Object.keys(res).sort()).toEqual(['cloudflare', 'vercel']);
    expect(res.twitter).toBeUndefined();
    expect(res.pinterest).toBeUndefined();
  });

  it('per-channel deadline records a hanging channel as timed-out without dropping the others', async () => {
    const res = await runAllChannels(urls, cfg, { deadlineMs: 50 });
    expect(res.cloudflare).toEqual({ success: 3, failed: 0 });
    expect(res.vercel).toEqual({ success: 3, failed: 0 });
    expect(res.twitter).toEqual({ success: 3, failed: 0 });
    // pinterest never settles → recorded as a timed-out failure for all urls,
    // instead of discarding every channel's result (the old 0/total behaviour).
    expect(res.pinterest).toEqual({ success: 0, failed: urls.length, timedOut: true });
  });

  it('isWarmChannel identifies the warm tier', () => {
    expect(isWarmChannel('cloudflare')).toBe(true);
    expect(isWarmChannel('vercel')).toBe(true);
    expect(isWarmChannel('twitter')).toBe(false);
    expect(isWarmChannel('google')).toBe(false);
  });
});
