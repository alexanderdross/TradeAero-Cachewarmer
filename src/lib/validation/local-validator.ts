import type { SchemaIssue } from './types';
import { TYPE_RULES, expandTypes, type TypeRule } from './rules';

const SCHEMA_ORG_RE = /^https?:\/\/schema\.org\/?$/i;

/**
 * Run local rule-based validation over a set of pre-parsed JSON-LD blocks.
 * No network calls. Returns one SchemaIssue per problem; severities follow
 * Google's distinction between required (error) and recommended (warning)
 * fields.
 */
export function validateLocal(blocks: Record<string, unknown>[]): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  for (const block of blocks) {
    issues.push(...validateNode(block));
  }

  return issues;
}

function validateNode(node: Record<string, unknown>, typeOverride?: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  // @context check applies only to top-level nodes (not array items where
  // typeOverride is set).
  if (typeOverride === undefined) {
    const ctx = node['@context'];
    if (ctx === undefined) {
      issues.push({
        severity: 'error',
        type: stringifyType(node['@type']) ?? 'Unknown',
        field: '@context',
        message: 'Missing @context — schema.org JSON-LD nodes require @context "https://schema.org".',
        source: 'local',
      });
    } else if (typeof ctx === 'string' && !SCHEMA_ORG_RE.test(ctx)) {
      // Permissive: some emitters use objects; we only flag obviously wrong strings.
      issues.push({
        severity: 'warning',
        type: stringifyType(node['@type']) ?? 'Unknown',
        field: '@context',
        message: `@context "${ctx}" is not schema.org — Google may not recognize this as structured data.`,
        source: 'local',
      });
    }
  }

  const types = typeOverride ? [typeOverride] : expandTypes(node['@type']);
  if (types.length === 0) {
    issues.push({
      severity: 'error',
      type: 'Unknown',
      field: '@type',
      message: 'Missing @type — JSON-LD nodes must declare a schema.org type.',
      source: 'local',
    });
    return issues;
  }

  for (const t of types) {
    const rule = TYPE_RULES[t];
    if (!rule) continue; // Unknown type — silently skip; not all types are governed.

    issues.push(...checkRule(node, t, rule));
  }

  return issues;
}

function checkRule(node: Record<string, unknown>, type: string, rule: TypeRule): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  for (const field of rule.required) {
    if (!hasMeaningfulValue(node[field])) {
      issues.push({
        severity: 'error',
        type,
        field,
        message: `Missing required field "${field}" on ${type}.`,
        source: 'local',
      });
    }
  }

  for (const field of rule.recommended) {
    if (!hasMeaningfulValue(node[field])) {
      issues.push({
        severity: 'warning',
        type,
        field,
        message: `Missing recommended field "${field}" on ${type} — rich-result features may be limited.`,
        source: 'local',
      });
    }
  }

  if (rule.itemRules) {
    for (const [field, itemRule] of Object.entries(rule.itemRules)) {
      const value = node[field];
      const items = Array.isArray(value) ? value : value !== undefined ? [value] : [];
      items.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return;
        const itemNode = item as Record<string, unknown>;
        // Item types may be omitted (e.g. BreadcrumbList items default to ListItem) —
        // validate against the parent's itemRule entry directly.
        for (const req of itemRule.required) {
          if (!hasMeaningfulValue(itemNode[req])) {
            issues.push({
              severity: 'error',
              type,
              field: `${field}[${idx}].${req}`,
              message: `Missing required field "${req}" on ${type}.${field} item ${idx + 1}.`,
              source: 'local',
            });
          }
        }
        for (const rec of itemRule.recommended) {
          if (!hasMeaningfulValue(itemNode[rec])) {
            issues.push({
              severity: 'warning',
              type,
              field: `${field}[${idx}].${rec}`,
              message: `Missing recommended field "${rec}" on ${type}.${field} item ${idx + 1}.`,
              source: 'local',
            });
          }
        }
      });
    }
  }

  return issues;
}

function hasMeaningfulValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

function stringifyType(t: unknown): string | null {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.filter((x) => typeof x === 'string').join('+') || null;
  return null;
}
