/**
 * Types for the schema.org / structured-data validation stage that runs
 * *before* each warming run. Validation is warn-only — invalid markup is
 * reported but every URL is still warmed. See `src/lib/validation/index.ts`.
 */

export type IssueSeverity = 'error' | 'warning';
export type IssueSource = 'local' | 'schema_org';

export interface SchemaIssue {
  severity: IssueSeverity;
  /** schema.org @type the issue was raised against (e.g. "Product", "JobPosting") */
  type: string;
  /** dot-path of the offending field within the JSON-LD node, when applicable */
  field?: string;
  /** Human-readable explanation. */
  message: string;
  /** Where the issue came from. */
  source: IssueSource;
}

export type UrlStatus = 'ok' | 'has_warnings' | 'has_errors' | 'fetch_failed';

export interface UrlValidationReport {
  url: string;
  status: UrlStatus;
  httpStatus?: number;
  /** schema.org @type values discovered in the page (deduped). */
  detectedTypes: string[];
  /** Count of `<script type="application/ld+json">` blocks parsed. */
  jsonLdCount: number;
  issues: SchemaIssue[];
  /** Wall-clock duration of fetch + validate, in ms. */
  durationMs: number;
}

export interface RunValidationSummary {
  total: number;
  ok: number;
  warningsOnly: number;
  errors: number;
  fetchFailed: number;
  reports: UrlValidationReport[];
}
