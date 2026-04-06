import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true });

type ParsedXml = Record<string, unknown>;

function extractFromUrlset(obj: ParsedXml): string[] {
  const urlset = obj['urlset'] as ParsedXml | undefined;
  if (!urlset) return [];
  const entries = Array.isArray(urlset['url']) ? urlset['url'] : [urlset['url']];
  return (entries as ParsedXml[])
    .map((e) => String(e['loc'] ?? '').trim())
    .filter(Boolean);
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
 * Returns a flat array of page URLs.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  depth = 0,
  indexOrigin?: string
): Promise<string[]> {
  if (depth > 4) {
    console.warn(`[sitemap] max recursion depth reached at ${sitemapUrl}`);
    return [];
  }

  const origin = new URL(sitemapUrl).origin;

  const res = await axios.get<string>(sitemapUrl, {
    timeout: 30_000,
    headers: { 'User-Agent': 'TradeAero-CacheWarmer/1.0' },
    responseType: 'text',
  });

  const parsed = parser.parse(res.data) as ParsedXml;

  // Sitemap index — recurse into child sitemaps
  if (parsed['sitemapindex']) {
    const childUrls = extractFromIndex(parsed);
    const results: string[] = [];
    for (let childUrl of childUrls) {
      // If child URL uses a different domain than the index, try rewriting to the index's origin first
      const childOrigin = new URL(childUrl).origin;
      if (childOrigin !== origin) {
        childUrl = childUrl.replace(childOrigin, origin);
        console.log(`[sitemap] rewrote child URL domain: ${childOrigin} → ${origin}`);
      }
      try {
        const children = await fetchSitemapUrls(childUrl, depth + 1, origin);
        results.push(...children);
      } catch (err) {
        console.warn(`[sitemap] skipping child sitemap ${childUrl}: ${(err as Error).message}`);
      }
    }
    return results;
  }

  // Standard urlset — return URLs as-is (page URLs keep their original domain)
  return extractFromUrlset(parsed);
}
