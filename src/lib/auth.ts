import { NextRequest } from 'next/server';
import crypto from 'crypto';

/**
 * Constant-time string comparison.
 *
 * `===` on secrets leaks length and prefix-match timing. `timingSafeEqual`
 * requires equal-length buffers, so we first compare lengths (this leak is
 * acceptable — secret length is not itself sensitive) and only then run the
 * constant-time compare on equal-length buffers.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyApiKey(request: NextRequest): boolean {
  const apiKey = process.env.CACHEWARMER_API_KEY;
  // Fail-closed: an unset key means no request can authenticate.
  if (!apiKey) return false;
  const provided = request.headers.get('x-api-key');
  if (!provided) return false;
  return safeEqual(provided, apiKey);
}

export function verifyCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // Fail-closed: an unset secret means no request can authenticate.
  if (!secret) return false;
  const header = request.headers.get('authorization');
  if (!header) return false;
  return safeEqual(header, `Bearer ${secret}`);
}
