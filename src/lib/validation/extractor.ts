import axios from 'axios';

export interface ExtractResult {
  httpStatus: number;
  /** Parsed JSON-LD nodes. `@graph` arrays are flattened so each top-level
   *  schema.org thing is its own entry. */
  blocks: Record<string, unknown>[];
  /** Parse errors (one per malformed `<script>` block). */
  parseErrors: string[];
}

// `<script type="application/ld+json" …>…</script>` — non-greedy body,
// case-insensitive opening tag, attributes may be in any order.
const JSON_LD_RE =
  /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Fetch a URL and extract every `application/ld+json` block from the HTML.
 * Follows the same axios conventions as `src/lib/channels/cdn.ts` so behavior
 * matches what the warming channel will actually see when it pulls the page.
 *
 * `@graph` arrays are flattened — Google treats each member as a separate
 * structured-data unit for rich-result eligibility, so we validate them
 * individually.
 */
export async function fetchAndExtractJsonLd(
  url: string,
  timeoutMs = 15_000,
): Promise<ExtractResult> {
  const res = await axios.get<string>(url, {
    timeout: timeoutMs,
    headers: {
      'User-Agent': 'TradeAero-CacheWarmer/1.0 (+structured-data-validator)',
      Accept: 'text/html,application/xhtml+xml',
    },
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s < 500,
  });

  const blocks: Record<string, unknown>[] = [];
  const parseErrors: string[] = [];

  const html = typeof res.data === 'string' ? res.data : String(res.data ?? '');
  let match: RegExpExecArray | null;
  // Reset lastIndex defensively — regex state on module-level constants survives
  // across calls and would corrupt subsequent extractions.
  JSON_LD_RE.lastIndex = 0;
  while ((match = JSON_LD_RE.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      for (const node of flattenJsonLd(parsed)) {
        blocks.push(node);
      }
    } catch (err) {
      parseErrors.push((err as Error).message || 'JSON parse error');
    }
  }

  return { httpStatus: res.status, blocks, parseErrors };
}

function flattenJsonLd(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    return node.flatMap((n) => flattenJsonLd(n));
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const graph = obj['@graph'];
    if (Array.isArray(graph)) {
      // Keep the wrapper too if it has its own @type — pages that wrap a
      // single Organization around a @graph of pages still want the wrapper
      // validated.
      const out = obj['@type'] ? [obj] : [];
      for (const child of graph) {
        out.push(...flattenJsonLd(child));
      }
      return out;
    }
    return [obj];
  }
  return [];
}
