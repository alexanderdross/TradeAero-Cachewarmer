/**
 * Per-(sequential-)channel wall-clock budget.
 *
 * Sequential channels (linkedin / twitter / pinterest) iterate URLs one-by-one
 * with a per-request timeout + an inter-request delay, so when an upstream
 * endpoint hangs to its timeout, a single `runAllChannels` call can run for
 * minutes (e.g. linkedin: 20s timeout + 5s delay ≈ 25s × N URLs). That is what
 * pushed `POST /api/jobs` past the 300s function cap and stranded runs in
 * `status='running'`.
 *
 * Capping each channel keeps `runAllChannels` resolving with real partial
 * results well under the route-level deadline (`WARM_DEADLINE_MS`, 250s) and
 * the cron per-batch budget (`BUDGET_MS`, 150s), so the slowest channel can no
 * longer monopolise the window. The budget is deliberately generous: a healthy
 * run answers in well under a second per URL, so it only bites once responses
 * start hanging toward their timeouts — it never truncates normal operation.
 */
export const SEQUENTIAL_CHANNEL_BUDGET_MS = 90_000;

/** A predicate that flips `true` once `ms` have elapsed since it was created. */
export function createDeadline(ms: number): () => boolean {
  const end = Date.now() + ms;
  return () => Date.now() >= end;
}
