import { describe, it, expect } from 'vitest';
import { validateLocal } from './local-validator';

describe('validateLocal', () => {
  it('flags Product missing required name + image as errors', () => {
    const issues = validateLocal([
      { '@context': 'https://schema.org', '@type': 'Product' },
    ]);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.some((i) => i.field === 'name')).toBe(true);
    expect(errors.some((i) => i.field === 'image')).toBe(true);
  });

  it('passes a fully-specified Product (with offers + brand) without errors', () => {
    const issues = validateLocal([
      {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Cessna 172',
        image: ['https://trade.aero/image.jpg'],
        description: 'A small aircraft',
        brand: { '@type': 'Brand', name: 'Cessna' },
        offers: { '@type': 'Offer', price: 100000, priceCurrency: 'EUR' },
        aggregateRating: { '@type': 'AggregateRating', ratingValue: 4.5, reviewCount: 12 },
        review: [{ '@type': 'Review', author: 'Pilot X' }],
      },
    ]);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('flags BreadcrumbList items missing position as errors with indexed field paths', () => {
    const issues = validateLocal([
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', name: 'Home', item: 'https://trade.aero/' },
          { '@type': 'ListItem', position: 2, name: 'Aircraft', item: 'https://trade.aero/aircraft' },
        ],
      },
    ]);
    const positionErrors = issues.filter(
      (i) => i.severity === 'error' && i.field?.startsWith('itemListElement[0]'),
    );
    expect(positionErrors.length).toBeGreaterThan(0);
    expect(positionErrors[0].field).toBe('itemListElement[0].position');
  });

  it('flags JobPosting missing hiringOrganization, jobLocation, and datePosted', () => {
    const issues = validateLocal([
      {
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Pilot',
        description: 'Fly aircraft',
      },
    ]);
    const errorFields = issues
      .filter((i) => i.severity === 'error')
      .map((i) => i.field);
    expect(errorFields).toContain('datePosted');
    expect(errorFields).toContain('hiringOrganization');
    expect(errorFields).toContain('jobLocation');
  });

  it('flags missing @context as an error', () => {
    const issues = validateLocal([{ '@type': 'Organization', name: 'TradeAero' }]);
    expect(
      issues.some((i) => i.severity === 'error' && i.field === '@context'),
    ).toBe(true);
  });

  it('flags wrong @context as a warning, not an error', () => {
    const issues = validateLocal([
      { '@context': 'https://example.com', '@type': 'Organization', name: 'TradeAero' },
    ]);
    const ctxIssue = issues.find((i) => i.field === '@context');
    expect(ctxIssue?.severity).toBe('warning');
  });

  it('flags missing @type as an error', () => {
    const issues = validateLocal([{ '@context': 'https://schema.org', name: 'X' }]);
    expect(
      issues.some((i) => i.severity === 'error' && i.field === '@type'),
    ).toBe(true);
  });

  it('handles array @type by validating each known type', () => {
    const issues = validateLocal([
      {
        '@context': 'https://schema.org',
        '@type': ['Product', 'Vehicle'],
        name: 'Cessna 172',
        image: ['https://trade.aero/x.jpg'],
      },
    ]);
    // Product requires name+image — both present. Vehicle requires name — present.
    // So we should have no errors, only recommendation warnings.
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('emits recommended-field warnings without errors when required fields are present', () => {
    const issues = validateLocal([
      {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'X',
        image: ['https://example.com/x.jpg'],
      },
    ]);
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    expect(errors).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    // brand / offers / description / aggregateRating / review are all recommended.
    expect(warnings.some((w) => w.field === 'offers')).toBe(true);
  });
});
