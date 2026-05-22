/**
 * Unit tests for the resumable-run helpers in runs.ts.
 *
 * The Supabase client is mocked with a tiny chainable query-builder stub —
 * each method returns `this` so the call chain matches the real builder, and
 * the terminal `await` resolves to whatever `result` is set to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures the filters/updates applied to the last query so assertions can
// inspect exactly what reapStaleRuns sent to Supabase.
const calls: {
  table?: string;
  updatePayload?: unknown;
  updateOpts?: unknown;
  filters: Array<{ op: string; args: unknown[] }>;
} = { filters: [] };

let result: { count: number | null; error: { message: string } | null } = {
  count: 0,
  error: null,
};

function makeQuery() {
  const q: Record<string, unknown> = {};
  const chain = (op: string) => (...args: unknown[]) => {
    calls.filters.push({ op, args });
    return q;
  };
  q.update = (payload: unknown, opts: unknown) => {
    calls.updatePayload = payload;
    calls.updateOpts = opts;
    return q;
  };
  q.eq = chain('eq');
  q.lt = chain('lt');
  q.in = chain('in');
  q.select = chain('select');
  q.order = chain('order');
  q.limit = chain('limit');
  // Make the builder awaitable — resolves to the configured result.
  q.then = (resolve: (v: unknown) => void) => resolve(result);
  return q;
}

vi.mock('./supabase', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      calls.table = table;
      return makeQuery();
    },
  }),
}));

import { reapStaleRuns } from './runs';

beforeEach(() => {
  calls.table = undefined;
  calls.updatePayload = undefined;
  calls.updateOpts = undefined;
  calls.filters = [];
  result = { count: 0, error: null };
});

describe('reapStaleRuns', () => {
  it('marks running rows with a stale heartbeat as failed', async () => {
    result = { count: 3, error: null };
    const reaped = await reapStaleRuns(600_000);

    expect(reaped).toBe(3);
    expect(calls.table).toBe('cachewarmer_runs');
    expect(calls.updatePayload).toMatchObject({ status: 'failed' });
    expect(calls.updateOpts).toEqual({ count: 'exact' });

    const eq = calls.filters.find((f) => f.op === 'eq');
    expect(eq?.args).toEqual(['status', 'running']);

    const lt = calls.filters.find((f) => f.op === 'lt');
    expect(lt?.args[0]).toBe('heartbeat_at');
  });

  it('returns 0 and does not throw when Supabase reports an error', async () => {
    result = { count: null, error: { message: 'boom' } };
    const reaped = await reapStaleRuns();
    expect(reaped).toBe(0);
  });

  it('returns 0 when no rows were reaped', async () => {
    result = { count: null, error: null };
    expect(await reapStaleRuns()).toBe(0);
  });
});
