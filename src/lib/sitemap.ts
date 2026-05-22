import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { assertAllowedUrl, isAllowedUrl, MAX_REDIRECTS } from './url-guard';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

type ParsedXml = Record<string, unknown>;

/**
 * Collect hreflang alternate URLs from a sitemap `<url>` entry.
 *
 * TradeAero is multi-locale (14 locales). A single page `<loc>` is typically
 * accompanied by `<xhtml:link rel="alternate" hreflang="…" href="…"/>`
 * entries pointing at the per-locale variants. Those alternates must be
 * warmed too — otherwise 13/14 locales of every page stay cold.
 *
 * fast-xml-parser surfaces the `<xhtml:link>` children under the `xhtml:link`
 * key (single object or array) with attributes prefixed by `@_`.
 */
function extractAlternateHrefs(entry: ParsedXml): string[] {
  const link = entry['xhtml:link'] ?? entry['link'];
  if (!link) return [];
  const links = Array.isArray(link) ? link : [link];
  return (links as ParsedXml[])
    .filter((l) => l && typeof l === 'object')
    .map((l) => String(l['@_href'] ?? l['href'] ?? '').trim())
    .filter(Boolean);
}

function extractFromUrlset(obj: ParsedXml): string[] {
  const urlset = obj['urlset'] as ParsedXml | undefined;
  if (!urlset) return [];
  const entries = Array.isArray(urlset['url']) ? urlset['url'] : [urlset['url']];
  const out: string[] = [];
  for (const e of entries as ParsedXml[]) {
    if (!e || typeof e !== 'object') continue;
    const loc = String(e['loc'] ?? '').trim();
    if (loc) out.push(loc);
    // Multi-locale: collect <xhtml:link rel="alternate" hreflang=…> hrefs.
    // Append element-by-element — `out.push(...arr)` spreads the array into
    // push()'s arguments and overflows the engine's argument-count limit
    // once the array is large enough.
    for (const href of extractAlternateHrefs(e)) out.push(href);
  }
  return out;
}

function extractFromIndex(obj: ParsedXml): string[] {
  const index = obj['sitemapindex'] as ParsedXml | undefined;
  if (!index) return [];
  const entries = Array.isArray(index['sitemap']) ? index['sitemap'] : [index['sitemap']];
  return (entries as ParsedXml[])
    .map((e) => String(e['loc'] ?? '').trim())
    .filter(Boolean);
}

/**
 * Fetch and parse a sitemap XML URL, recursively resolving sitemap indexes.
 * Returns a flat array of page URLs, de-duplicated so each URL is warmed /
 * submitted at most once per run.
 *
 * De-duplication matters because TradeAero now publishes dedicated image
 * sitemaps (`sitemap-images-<section>.xml`) alongside the combined
 * `sitemap-<section>.xml`. Both reference the same page `<loc>` values —
 * the image sitemap just carries extra `<image:image>` blocks that this
 * parser ignores. Without a `Set()` guard every page URL would be warmed
 * twice and every social/search channel submission would double-fire,
 * wasting API budget (Google Indexing API: 200 URL notifications/day).
 *
 * The same Set also collapses duplicate hreflang alternates: a page and its
 * 14 locale variants cross-reference each other, so the same href appears in
 * many `<url>` blocks.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  depth = 0,
): Promise<string[]> {
  // SSRF guard: the sitemap URL can come straight from the POST /api/jobs
  // request body. Fail-closed before any outbound fetch.
  assertAllowedUrl(sitemapUrl);
  const seen = new Set<string>();
  for (const url of await collectSitemapUrls(sitemapUrl, depth)) {
    seen.add(url);
  }
  return Array.from(seen);
}

/**
 * Internal recursive walker. Returns every collected URL seen during the
 * walk without de-duplicating — `fetchSitemapUrls()` above applies the Set.
 *
 * A failed fetch of one (child) sitemap is treated as an empty sitemap and
 * does not abort sibling sitemaps in an index.
 */
async function collectSitemapUrls(
  sitemapUrl: string,
  depth: number,
): Promise<string[]> {
  if (depth > 4) {
    console.warn(`[sitemap] max recursion depth reached at ${sitemapUrl}`);
    return [];
  }

  const origin = new URL(sitemapUrl).origin;

  let res;
  try {
    res = await axios.get<string>(sitemapUrl, {
      timeout: 30_000,
      headers: { 'User-Agent': 'TradeAero-CacheWarmer/1.0' },
      responseType: 'text',
      maxRedirects: MAX_REDIRECTS,
    });
  } catch (err) {
    // A 404 on the sitemap is the normal state on trade.aero while the
    // pre-prod gate is on (src/app/2d6a9a/**/route.ts short-circuits to
    // 404 when PREPROD_GATE_ENABLED=true). Treat any fetch failure as an
    // empty sitemap so /api/cron/warm returns `{skipped: "sitemap_empty"}`
    // instead of erroring out. For a child sitemap inside an index this
    // means the bad child is skipped while its siblings still resolve.
    const status = (err as { response?: { status?: number } }).response?.status;
    console.warn(`[sitemap] fetch failed for ${sitemapUrl} (status=${status ?? "n/a"}): treating as empty`);
    return [];
  }

  const parsed = parser.parse(res.data) as ParsedXml;

  // Sitemap index — recurse into child sitemaps
  if (parsed['sitemapindex']) {
    const childUrls = extractFromIndex(parsed);
    const results: string[] = [];
    for (let childUrl of childUrls) {
      // If the child URL uses a different domain than the index, try
      // rewriting to the index's origin first. A malformed <loc> would make
      // `new URL()` throw — skip just that entry instead of aborting the
      // whole index walk.
      try {
        const childOrigin = new URL(childUrl).origin;
        if (childOrigin !== origin) {
          childUrl = childUrl.replace(childOrigin, origin);
          console.log(`[sitemap] rewrote child URL domain: ${childOrigin} → ${origin}`);
        }
      } catch {
        console.warn(`[sitemap] skipping malformed child <loc>: ${childUrl}`);
        continue;
      }
      // SSRF guard for the (possibly rewritten) child sitemap URL.
      if (!isAllowedUrl(childUrl)) {
        console.warn(`[sitemap] skipping disallowed child sitemap: ${childUrl}`);
        continue;
      }
      // collectSitemapUrls treats fetch failures as empty, so a bad child
      // sitemap is skipped here without aborting its siblings.
      const children = await collectSitemapUrls(childUrl, depth + 1);
      // Append element-by-element. `results.push(...children)` spreads the
      // child array into push()'s arguments — a child sitemap shard yields
      // thousands of page URLs × ~14 hreflang alternates, which overflows
      // the engine's argument-count limit ("Maximum call stack size
      // exceeded") and 500s the whole /api/cron/warm tick.
      for (const u of children) results.push(u);
    }
    return results;
  }

  // Standard urlset — return page URLs and their hreflang alternates as-is.
  return extractFromUrlset(parsed);
}
