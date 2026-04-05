import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { getRun } from '@/lib/runs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!verifyApiKey(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(run);
}
