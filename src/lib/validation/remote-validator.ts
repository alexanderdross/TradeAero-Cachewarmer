import axios from 'axios';
import type { SchemaIssue } from './types';
import { expandTypes } from './rules';

/**
 * Remote validation against https://validator.schema.org/validate. Opt-in
 * via `config.validation.useRemoteValidator` — defaults off so a single warm
 * run doesn't fan out an extra request per page to a third-party service.
 *
 * Note: Google's Rich Results Test does NOT expose a public API
 * (developers.google.com/search/docs/appearance/structured-data states the
 * tool is only accessible via the web UI). validator.schema.org gives us
 * spec-level conformance checks; we layer that on top of our own local
 * rules-table for Google's "required-for-rich-results" expectations.
 */
const VALIDATOR_URL = 'https://validator.schema.org/validate';

interface ValidatorResponse {
  errors?: Array<{ message?: string; type?: string; property?: string }>;
  warnings?: Array<{ message?: string; type?: string; property?: string }>;
  // The endpoint returns additional fields we don't currently use.
}

export async function validateRemote(
  blocks: Record<string, unknown>[],
  timeoutMs = 5_000,
): Promise<SchemaIssue[]> {
  if (blocks.length === 0) return [];

  const issues: SchemaIssue[] = [];

  for (const block of blocks) {
    const fallbackType = expandTypes((block as Record<string, unknown>)['@type'])[0] ?? 'Unknown';
    try {
      const body = new URLSearchParams({ code: JSON.stringify(block) }).toString();
      const res = await axios.post<ValidatorResponse>(VALIDATOR_URL, body, {
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'TradeAero-CacheWarmer/1.0 (+structured-data-validator)',
        },
        validateStatus: (s) => s < 500,
      });

      const data = (res.data ?? {}) as ValidatorResponse;
      for (const err of data.errors ?? []) {
        issues.push({
          severity: 'error',
          type: err.type ?? fallbackType,
          field: err.property,
          message: err.message ?? 'validator.schema.org reported an unspecified error.',
          source: 'schema_org',
        });
      }
      for (const warn of data.warnings ?? []) {
        issues.push({
          severity: 'warning',
          type: warn.type ?? fallbackType,
          field: warn.property,
          message: warn.message ?? 'validator.schema.org reported an unspecified warning.',
          source: 'schema_org',
        });
      }
    } catch (err) {
      // Never let a remote-validator outage block a run — record a single
      // warning so the report is honest about the gap and move on.
      issues.push({
        severity: 'warning',
        type: fallbackType,
        message: `Remote schema.org validator unreachable: ${(err as Error).message ?? 'unknown error'}.`,
        source: 'schema_org',
      });
      // Bail out of the rest of the blocks for this URL — one outage means
      // they'll all fail; no point burning more time.
      break;
    }
  }

  return issues;
}
