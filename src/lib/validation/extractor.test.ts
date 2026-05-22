import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { fetchAndExtractJsonLd } from './extractor';

vi.mock('axios');
const mockedAxios = axios as unknown as { get: ReturnType<typeof vi.fn> };

describe('fetchAndExtractJsonLd', () => {
  beforeEach(() => {
    mockedAxios.get = vi.fn();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('extracts a single JSON-LD block', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: `<html><head>
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"X"}
        </script>
      </head></html>`,
    });
    const out = await fetchAndExtractJsonLd('https://trade.aero/x');
    expect(out.httpStatus).toBe(200);
    expect(out.blocks).toHaveLength(1);
    expect((out.blocks[0] as { '@type': string })['@type']).toBe('Product');
    expect(out.parseErrors).toHaveLength(0);
  });

  it('flattens @graph arrays so each node validates independently', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: `<script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[
          {"@type":"WebSite","name":"TradeAero","url":"https://trade.aero"},
          {"@type":"Organization","name":"TradeAero"}
        ]}
      </script>`,
    });
    const out = await fetchAndExtractJsonLd('https://trade.aero/');
    const types = out.blocks.map((b) => (b as { '@type': string })['@type']);
    expect(types).toContain('WebSite');
    expect(types).toContain('Organization');
  });

  it('captures parse errors for malformed JSON-LD blocks instead of throwing', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: `<script type="application/ld+json">{ not valid json }</script>
             <script type="application/ld+json">{"@type":"Product","name":"X"}</script>`,
    });
    const out = await fetchAndExtractJsonLd('https://trade.aero/x');
    expect(out.blocks).toHaveLength(1);
    expect(out.parseErrors).toHaveLength(1);
  });

  it('finds multiple blocks across the document', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: `<html>
        <script type='application/ld+json'>{"@type":"Organization","name":"O"}</script>
        <body>
          <script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
        </body>
      </html>`,
    });
    const out = await fetchAndExtractJsonLd('https://trade.aero/');
    expect(out.blocks).toHaveLength(2);
  });

  it('returns httpStatus for 4xx responses without throwing', async () => {
    mockedAxios.get.mockResolvedValueOnce({ status: 404, data: '<html></html>' });
    const out = await fetchAndExtractJsonLd('https://trade.aero/missing');
    expect(out.httpStatus).toBe(404);
    expect(out.blocks).toHaveLength(0);
  });
});
