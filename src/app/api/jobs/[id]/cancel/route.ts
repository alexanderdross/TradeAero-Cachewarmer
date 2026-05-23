import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { cancelRun } from '@/lib/runs';

export const maxDuration = 10;

/**
 * POST /api/jobs/[id]/cancel
 *
 * Operator-initiated cancel for an in-flight run (warm or validation_only).
 * Atomic via `cancelRun()` — flips a `running` row to `cancelled`. The
 * `/api/cron/warm` tick re-checks status at the top of each batch and
 * bails cleanly the next time it picks the row up (typically within a
 * single batch, ~30s in practice).
 *
 * Returns 409 if the row is no longer `running` — the run finished or
 * failed naturally between the operator's click and this handler.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  try {
    const cancelled = await cancelRun(id);
    if (!cancelled) {
      return NextResponse.json(
        { cancelled: false, reason: 'not_running' },
        { status: 409 },
      );
    }
    return NextResponse.json({ cancelled: true, runId: id });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
