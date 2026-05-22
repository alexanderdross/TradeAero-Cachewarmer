import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { listValidationResults } from '@/lib/runs';

export const maxDuration = 30;

/**
 * GET /api/jobs/[id]/validation?status=ok|has_warnings|has_errors|fetch_failed
 *
 * Returns the per-URL schema-validation report for a single warm run.
 * Optional `status` query param filters to only matching rows.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const statusFilter = request.nextUrl.searchParams.get('status') ?? undefined;

  try {
    const rows = await listValidationResults(
      id,
      statusFilter ? { status: statusFilter } : undefined,
    );

    const totals = {
      total: rows.length,
      ok: rows.filter((r) => r.status === 'ok').length,
      has_warnings: rows.filter((r) => r.status === 'has_warnings').length,
      has_errors: rows.filter((r) => r.status === 'has_errors').length,
      fetch_failed: rows.filter((r) => r.status === 'fetch_failed').length,
    };

    return NextResponse.json({ runId: id, totals, results: rows });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
