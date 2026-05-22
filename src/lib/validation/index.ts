import pLimit from 'p-limit';
import { fetchAndExtractJsonLd } from './extractor';
import { validateLocal } from './local-validator';
import { validateRemote } from './remote-validator';
import { expandTypes } from './rules';
import type {
  RunValidationSummary,
  SchemaIssue,
  UrlStatus,
  UrlValidationReport,
} from './types';

export interface ValidationOptions {
  concurrency: number;
  useRemoteValidator: boolean;
  fetchTimeoutMs: number;
}

export const DEFAULT_VALIDATION_OPTIONS: ValidationOptions = {
  concurrency: 4,
  useRemoteValidator: false,
  fetchTimeoutMs: 15_000,
};

/**
 * Pre-warm validation gate. Fetches every URL, extracts JSON-LD blocks,
 * runs them through the local rule-table and (optionally) the public
 * schema.org validator, and returns a per-URL report.
 *
 * **Warn-only**: this never throws on individual URL failures and never
 * filters out URLs from the warming pipeline. The summary is observability
 * material — the caller persists it and continues to call runAllChannels()
 * regardless.
 */
export async function validateUrlBatch(
  urls: string[],
  options: Partial<ValidationOptions> = {},
): Promise<RunValidationSummary> {
  const opts: ValidationOptions = { ...DEFAULT_VALIDATION_OPTIONS, ...options };
  const limit = pLimit(Math.max(1, opts.concurrency));

  const reports = await Promise.all(
    urls.map((url) => limit(() => validateOneUrl(url, opts))),
  );

  return summarize(reports);
}

async function validateOneUrl(
  url: string,
  options: ValidationOptions,
): Promise<UrlValidationReport> {
  const startedAt = Date.now();
  const issues: SchemaIssue[] = [];
  const detectedTypes = new Set<string>();
  let httpStatus: number | undefined;
  let jsonLdCount = 0;
  let status: UrlStatus = 'ok';

  try {
    const { httpStatus: hs, blocks, parseErrors } = await fetchAndExtractJsonLd(
      url,
      options.fetchTimeoutMs,
    );
    httpStatus = hs;
    jsonLdCount = blocks.length;

    for (const err of parseErrors) {
      issues.push({
        severity: 'error',
        type: 'Unknown',
        message: `Malformed JSON-LD block: ${err}`,
        source: 'local',
      });
    }

    if (hs >= 400) {
      // Page itself errored — still report whatever JSON-LD we managed to parse,
      // but mark the URL as fetch_failed so it's visible in the dashboard.
      issues.push({
        severity: 'error',
        type: 'HTTP',
        message: `HTTP ${hs} response — page may be unwarmable or schema markup may be missing.`,
        source: 'local',
      });
      status = 'fetch_failed';
    } else if (blocks.length === 0) {
      issues.push({
        severity: 'warning',
        type: 'Page',
        message: 'No <script type="application/ld+json"> blocks found on this page.',
        source: 'local',
      });
    }

    for (const block of blocks) {
      for (const t of expandTypes((block as Record<string, unknown>)['@type'])) {
        detectedTypes.add(t);
      }
    }

    issues.push(...validateLocal(blocks));
    if (options.useRemoteValidator && blocks.length > 0) {
      issues.push(...(await validateRemote(blocks)));
    }
  } catch (err) {
    issues.push({
      severity: 'error',
      type: 'HTTP',
      message: `Fetch failed: ${(err as Error).message ?? 'unknown error'}.`,
      source: 'local',
    });
    status = 'fetch_failed';
  }

  if (status !== 'fetch_failed') {
    const hasError = issues.some((i) => i.severity === 'error');
    const hasWarn = issues.some((i) => i.severity === 'warning');
    status = hasError ? 'has_errors' : hasWarn ? 'has_warnings' : 'ok';
  }

  return {
    url,
    status,
    httpStatus,
    detectedTypes: Array.from(detectedTypes),
    jsonLdCount,
    issues,
    durationMs: Date.now() - startedAt,
  };
}

function summarize(reports: UrlValidationReport[]): RunValidationSummary {
  let ok = 0,
    warningsOnly = 0,
    errors = 0,
    fetchFailed = 0;
  for (const r of reports) {
    switch (r.status) {
      case 'ok':
        ok++;
        break;
      case 'has_warnings':
        warningsOnly++;
        break;
      case 'has_errors':
        errors++;
        break;
      case 'fetch_failed':
        fetchFailed++;
        break;
    }
  }
  return { total: reports.length, ok, warningsOnly, errors, fetchFailed, reports };
}
