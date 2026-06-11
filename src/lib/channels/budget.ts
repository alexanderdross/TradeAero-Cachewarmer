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

/**
 * Per-(parallel-)warm-channel wall-clock budget.
 *
 * The warm channels (cdn / cloudflare / vercel) fan URLs out in parallel with
 * p-limit and are fast when healthy, but on a large URL set (e.g. a
 * full-sitemap warm of tens of thousands of URLs) they cannot finish within a
 * single invocation. Without an internal budget they relied entirely on
 * `runAllChannels`' `withChannelDeadline` wrapper — which, on timeout, reports
 * `{ success: 0, failed: total }`, discarding every URL the channel had
 * already warmed. That marked otherwise-successful warms as `failed` (the
 * all-red "0/total" run history).
 *
 * Giving the warm channels the same early-exit budget the sequential channels
 * use lets them drain the remaining queue as failed *without* throwing away
 * the successes they accumulated, so the channel returns real partial counts.
 * `runAllChannels` narrows this to its own per-channel deadline when one is
 * set, so the channel always settles before the wrapper would fire. The
 * default is generous: a healthy warm answers in well under a second per URL,
 * so the budget only bites on oversized runs and never truncates the small,
 * cursor-chunked batches the cron drives.
 */
export const WARM_CHANNEL_BUDGET_MS = 220_000;

/** A predicate that flips `true` once `ms` have elapsed since it was created. */
export function createDeadline(ms: number): () => boolean {
  const end = Date.now() + ms;
  return () => Date.now() >= end;
}
