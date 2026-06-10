import { describe, it, expect, vi, afterEach } from 'vitest';
import { SEQUENTIAL_CHANNEL_BUDGET_MS, createDeadline } from './budget';
import { warmTwitter } from './twitter';
import { warmPinterest } from './pinterest';
import { warmLinkedin } from './linkedin';

describe('createDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it('is false before the budget elapses and true after', () => {
    vi.useFakeTimers();
    const over = createDeadline(1_000);
    expect(over()).toBe(false);
    vi.advanceTimersByTime(999);
    expect(over()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(over()).toBe(true);
  });

  it('exposes a sane default budget well under the 250s route deadline', () => {
    expect(SEQUENTIAL_CHANNEL_BUDGET_MS).toBeGreaterThan(0);
    expect(SEQUENTIAL_CHANNEL_BUDGET_MS).toBeLessThan(250_000);
  });
});

describe('sequential channels honour an exhausted budget', () => {
  // budgetMs: 0 makes the deadline fire on the first iteration, so no outbound
  // request is ever issued; every URL is counted as failed (not warmed).
  const urls = ['https://trade.aero/a', 'https://trade.aero/b', 'https://trade.aero/c'];

  it('twitter', async () => {
    expect(await warmTwitter(urls, { budgetMs: 0, delayBetweenRequests: 0 }))
      .toEqual({ success: 0, failed: 3 });
  });

  it('pinterest', async () => {
    expect(await warmPinterest(urls, { budgetMs: 0, delayBetweenRequests: 0 }))
      .toEqual({ success: 0, failed: 3 });
  });

  it('linkedin', async () => {
    expect(await warmLinkedin(urls, { sessionCookie: 'x', budgetMs: 0, delayBetweenRequests: 0 }))
      .toEqual({ success: 0, failed: 3 });
  });
});
