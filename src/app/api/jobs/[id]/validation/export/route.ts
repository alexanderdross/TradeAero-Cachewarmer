import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { listValidationResults, type ValidationResultRow } from '@/lib/runs';
import type { SchemaIssue } from '@/lib/validation/types';

export const maxDuration = 60;

/**
 * GET /api/jobs/[id]/validation/export?format=csv|json
 *
 * Streams the full per-URL schema-validation report as a downloadable file.
 * Default format is CSV (RFC 4180 escaping). JSON returns the raw row
 * shape as written to cachewarmer_validation_results.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const format = (request.nextUrl.searchParams.get('format') ?? 'csv').toLowerCase();

  let rows: ValidationResultRow[];
  try {
    rows = await listValidationResults(id);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  if (format === 'json') {
    return new NextResponse(JSON.stringify({ runId: id, results: rows }, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="validation-${id}.json"`,
      },
    });
  }

  const csv = toCsv(rows);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="validation-${id}.csv"`,
    },
  });
}

const COLUMNS = [
  'url',
  'status',
  'http_status',
  'detected_types',
  'json_ld_count',
  'error_count',
  'warning_count',
  'duration_ms',
  'issues',
] as const;

function toCsv(rows: ValidationResultRow[]): string {
  const lines: string[] = [COLUMNS.join(',')];
  for (const row of rows) {
    const issues = Array.isArray(row.issues) ? (row.issues as SchemaIssue[]) : [];
    const issuesText = issues
      .map((i) => `[${i.severity.toUpperCase()}] ${i.type}${i.field ? '.' + i.field : ''}: ${i.message}`)
      .join(' | ');
    lines.push(
      [
        row.url,
        row.status,
        row.http_status ?? '',
        (row.detected_types ?? []).join('+'),
        row.json_ld_count,
        row.error_count,
        row.warning_count,
        row.duration_ms ?? '',
        issuesText,
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return lines.join('\n');
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
