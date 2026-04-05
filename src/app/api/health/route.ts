import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ ok: true, service: 'tradeaero-cachewarmer', timestamp: new Date().toISOString() });
}
