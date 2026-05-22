/**
 * SSRF hardening: shared host-allowlist guard for outbound fetches of
 * caller-influenced URLs.
 *
 * The cache-warmer fetches sitemaps, page HTML (validation) and warms CDN
 * URLs. Several of those URLs originate from caller-supplied request bodies
 * (`POST /api/jobs` accepts `sitemapUrl` and `urls[]`). Without a host
 * restriction an attacker could point the service at internal/cloud-metadata
 * endpoints (classic SSRF), and axios following redirects would let an
 * allowed host bounce the request elsewhere.
 *
 * Policy: only http(s) URLs whose hostname is one of the allowed apex hosts
 * (default `trade.aero`) or a subdomain of one of them are permitted. IP
 * literals are always rejected.
 *
 * The allowlist is configurable via `WARM_ALLOWED_HOSTS` (comma-separated).
 */

/** How many redirects axios should follow for caller-influenced fetches. */
export const MAX_REDIRECTS = 2;

function allowedHosts(): string[] {
  const raw = process.env.WARM_ALLOWED_HOSTS;
  const hosts = (raw && raw.trim() ? raw : 'trade.aero')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? hosts : ['trade.aero'];
}

// Rough IPv4 / IPv6 literal detection — we reject any IP literal outright
// rather than trying to classify private vs public ranges.
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function isIpLiteral(hostname: string): boolean {
  if (IPV4_RE.test(hostname)) return true;
  // IPv6 literals appear bracketed in URL.hostname only without brackets,
  // but `new URL()` strips the brackets — a colon in a hostname is a strong
  // signal of an IPv6 literal.
  if (hostname.includes(':')) return true;
  return false;
}

/**
 * Returns true if `rawUrl` is a well-formed http(s) URL whose host is the
 * allowlisted apex or a subdomain of it, and is not an IP literal.
 */
export function isAllowedUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || isIpLiteral(hostname)) return false;
  if (hostname === 'localhost') return false;

  return allowedHosts().some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}

/**
 * Throws if `rawUrl` is not allowed. Use to fail-closed before any outbound
 * fetch of a caller-influenced URL.
 */
export function assertAllowedUrl(rawUrl: string): void {
  if (!isAllowedUrl(rawUrl)) {
    throw new Error(`URL not permitted by host allowlist: ${rawUrl}`);
  }
}
