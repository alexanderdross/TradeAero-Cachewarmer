import { NextRequest } from 'next/server';

export function verifyApiKey(request: NextRequest): boolean {
  const apiKey = process.env.CACHEWARMER_API_KEY;
  if (!apiKey) return false;
  return request.headers.get('x-api-key') === apiKey;
}

export function verifyCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}
