import { NextRequest, NextResponse } from 'next/server';
import { verifyApiKey } from '@/lib/auth';
import { loadServiceConfig } from '@/lib/config';
import { listSitemapIndex } from '@/lib/sitemap';

export const maxDuration = 30;

/**
 * GET /api/sitemap-sections
 *
 * Returns the shard URLs declared in the root sitemap index, with a derived
 * human-readable label per shard. Used by the admin "Trigger warm" / "Validate
 * now" cards to render a multi-select chip set so an operator can scope a run
 * to a subset of sections (e.g. only `sitemap-aircraft.xml` +
 * `sitemap-images-aircraft.xml`) instead of always walking the whole index.
 *
 * Drift-proof: reads the live index, so newly added shards (rentals when MVP
 * gate lifts, future content types) show up automatically without a code
 * change here or in the UI.
 *
 * The selected shard URLs are passed back as `sections: string[]` on the
 * POST body to /api/jobs[/validate]; both routes SSRF-validate every entry
 * before fetching.
 */
export async function GET(request: NextRequest) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const config = await loadServiceConfig();
    const shards = await listSitemapIndex(config.sitemapUrl);

    return NextResponse.json({
      rootUrl: config.sitemapUrl,
      sections: shards.map((url) => ({ url, label: labelFromShardUrl(url) })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? String(err) },
      { status: 500 },
    );
  }
}

/**
 * Derive a short human label from a shard URL. Drops the `sitemap-` prefix
 * and `.xml` suffix so e.g. `https://trade.aero/2d6a9a/sitemap-aircraft.xml`
 * → `aircraft`, `sitemap-images-aircraft.xml` → `images-aircraft`. The UI
 * can further group `images-*` shards under their parent section if it
 * wants — that lives entirely in the UI.
 */
function labelFromShardUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split('/').pop() ?? path;
    return base.replace(/^sitemap-/, '').replace(/\.xml$/, '') || base;
  } catch {
    return url;
  }
}
