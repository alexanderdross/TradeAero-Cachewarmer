import axios from 'axios';
import { assertAllowedUrl, MAX_REDIRECTS } from '../url-guard';

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
  // SSRF guard: validated URLs derive from caller-supplied sitemap/url lists.
  assertAllowedUrl(url);
  const res = await axios.get<string>(url, {
    timeout: timeoutMs,
    headers: {
      'User-Agent': 'TradeAero-CacheWarmer/1.0 (+structured-data-validator)',
      Accept: 'text/html,application/xhtml+xml',
    },
    maxRedirects: MAX_REDIRECTS,
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

// Deeply-nested @graph chains are almost always malformed or hostile;
// a finite cap stops a pathological page from blowing the stack.
export const MAX_GRAPH_DEPTH = 64;

/**
 * Flatten a parsed JSON-LD value into a list of schema.org nodes,
 * expanding nested `@graph` arrays. Exported for unit testing.
 */
export function flattenJsonLd(
  node: unknown,
  depth = 0,
): Record<string, unknown>[] {
  if (depth > MAX_GRAPH_DEPTH) return [];
  if (Array.isArray(node)) {
    return node.flatMap((n) => flattenJsonLd(n, depth + 1));
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const graph = obj['@graph'];
    if (Array.isArray(graph)) {
      // Keep the wrapper too if it has its own @type — pages that wrap a
      // single Organization around a @graph of pages still want the wrapper
      // validated.
      const out: Record<string, unknown>[] = obj['@type'] ? [obj] : [];
      for (const child of graph) {
        // Append element-by-element. `out.push(...flattenJsonLd(child))`
        // spreads the child array into push()'s arguments, and a large
        // enough (or deeply nested) @graph overflows the engine's
        // argument-count limit — surfacing as the RangeError
        // "Maximum call stack size exceeded".
        for (const flattened of flattenJsonLd(child, depth + 1)) {
          out.push(flattened);
        }
      }
      return out;
    }
    return [obj];
  }
  return [];
}
