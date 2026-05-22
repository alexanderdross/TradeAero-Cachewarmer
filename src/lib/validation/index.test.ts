import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { validateUrlBatch } from './index';

vi.mock('axios');
const mockedAxios = axios as unknown as { get: ReturnType<typeof vi.fn> };

const GOOD_PRODUCT_HTML = `<html><head>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product","name":"X","image":["https://trade.aero/x.jpg"],"description":"d","brand":{"@type":"Brand","name":"b"},"offers":{"@type":"Offer","price":1,"priceCurrency":"EUR"},"aggregateRating":{"@type":"AggregateRating","ratingValue":4},"review":[{"@type":"Review","author":"a"}]}
  </script>
</head></html>`;

const BROKEN_PRODUCT_HTML = `<html><head>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Product"}
  </script>
</head></html>`;

describe('validateUrlBatch', () => {
  beforeEach(() => {
    mockedAxios.get = vi.fn();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('classifies a fully valid page as ok', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: GOOD_PRODUCT_HTML });
    const summary = await validateUrlBatch(['https://trade.aero/a'], {
      concurrency: 1,
      useRemoteValidator: false,
    });
    expect(summary.total).toBe(1);
    expect(summary.ok).toBe(1);
    expect(summary.errors).toBe(0);
  });

  it('classifies a page missing required fields as has_errors', async () => {
    mockedAxios.get.mockResolvedValue({ status: 200, data: BROKEN_PRODUCT_HTML });
    const summary = await validateUrlBatch(['https://trade.aero/b'], {
      concurrency: 1,
      useRemoteValidator: false,
    });
    expect(summary.errors).toBe(1);
    expect(summary.reports[0].status).toBe('has_errors');
  });

  it('classifies a network failure as fetch_failed and does not throw', async () => {
    mockedAxios.get.mockRejectedValue(new Error('ECONNRESET'));
    const summary = await validateUrlBatch(['https://trade.aero/c'], {
      concurrency: 1,
      useRemoteValidator: false,
    });
    expect(summary.fetchFailed).toBe(1);
    expect(summary.reports[0].status).toBe('fetch_failed');
  });

  it('classifies pages without JSON-LD as has_warnings (still warmable)', async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: '<html><body>no structured data here</body></html>',
    });
    const summary = await validateUrlBatch(['https://trade.aero/d'], {
      concurrency: 1,
      useRemoteValidator: false,
    });
    expect(summary.warningsOnly).toBe(1);
    expect(summary.reports[0].status).toBe('has_warnings');
  });

  it('respects concurrency and aggregates totals across multiple URLs', async () => {
    mockedAxios.get
      .mockResolvedValueOnce({ status: 200, data: GOOD_PRODUCT_HTML })
      .mockResolvedValueOnce({ status: 200, data: BROKEN_PRODUCT_HTML })
      .mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const summary = await validateUrlBatch(
      ['https://trade.aero/a', 'https://trade.aero/b', 'https://trade.aero/c'],
      { concurrency: 2, useRemoteValidator: false },
    );
    expect(summary.total).toBe(3);
    expect(summary.ok).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.fetchFailed).toBe(1);
  });
});
