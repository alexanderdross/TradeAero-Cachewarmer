/**
 * Dead-man's-switch / failure ping for the warm cron, mirroring the pattern in
 * TradeAero-Indexing (`src/utils/heartbeat.ts`).
 *
 * A GitHub/Vercel `schedule:` can silently stop firing, and a run can also
 * *complete* while every URL fails or while the watchdog is reaping stranded
 * `running` rows — neither emits an alert on its own. An external monitor
 * (healthchecks.io / cronitor / Better Stack) expects a ping on every healthy
 * tick and a `<url>/fail` ping on an unhealthy one, and alerts when either the
 * ping stops arriving or a failure is reported.
 *
 * Best-effort: 5s timeout, never throws — monitoring must never fail a run.
 * No-op when `HEARTBEAT_URL` is unset (the URL itself is the credential).
 */
export async function pingHeartbeat(healthy: boolean): Promise<void> {
  const base = process.env.HEARTBEAT_URL;
  if (!base) return;
  const url = healthy ? base : `${base.replace(/\/$/, '')}/fail`;
  try {
    await fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000) });
  } catch {
    // Monitoring is observability only — swallow network/timeout errors.
  }
}
