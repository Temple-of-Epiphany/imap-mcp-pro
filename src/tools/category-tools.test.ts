// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for evaluateCategories — the dry-run categorization analysis (#72).

import { describe, expect, it } from 'vitest';
import { evaluateCategories, recommendKeywords } from './category-tools.js';

const CATS = [
  { category_name: 'Newsletters', keywords: 'newsletter, digest', target_folder: 'INBOX/News' },
  { category_name: 'Receipts', keywords: 'receipt; invoice', target_folder: 'INBOX/Receipts' },
];

describe('evaluateCategories (#72)', () => {
  it('counts coverage, per-category, and uncategorized', () => {
    const a = evaluateCategories([
      { uid: 1, from: 'news@x.com', subject: 'Weekly newsletter' },
      { uid: 2, from: 'shop@y.com', subject: 'Your invoice #42' },
      { uid: 3, from: 'bob@z.com', subject: 'lunch?' },
    ], CATS);
    expect(a.total).toBe(3);
    expect(a.categorized).toBe(2);
    expect(a.uncategorized).toBe(1);
    expect(a.coveragePercent).toBeCloseTo(66.7, 1);
    expect(a.perCategory.Newsletters.count).toBe(1);
    expect(a.perCategory.Receipts.count).toBe(1);
    expect(a.uncategorizedList[0].uid).toBe(3);
  });

  it('reports the matched keyword + destination (first-match-wins)', () => {
    const a = evaluateCategories([{ uid: 5, from: 'a@x.com', subject: 'Monthly digest' }], CATS);
    expect(a.matched[0]).toMatchObject({ uid: 5, matchedCategory: 'Newsletters', matchedKeyword: 'digest', destination: 'INBOX/News' });
  });

  it('flags conflicts when an email matches multiple categories', () => {
    const a = evaluateCategories([
      { uid: 9, from: 'billing@x.com', subject: 'newsletter: your invoice is ready' }, // matches both
    ], CATS);
    expect(a.conflicts).toBe(1);
    expect(a.matched[0].allCategories.sort()).toEqual(['Newsletters', 'Receipts']);
    // destination follows category order (Newsletters first)
    expect(a.matched[0].destination).toBe('INBOX/News');
  });

  it('matches against sender as well as subject, case-insensitively', () => {
    const a = evaluateCategories([{ uid: 7, from: 'NEWSLETTER@brand.com', subject: 'Hi' }], CATS);
    expect(a.categorized).toBe(1);
    expect(a.matched[0].matchedCategory).toBe('Newsletters');
  });

  it('handles an empty email set', () => {
    const a = evaluateCategories([], CATS);
    expect(a).toMatchObject({ total: 0, categorized: 0, coveragePercent: 0, conflicts: 0 });
  });
});

describe('recommendKeywords (#73)', () => {
  const SAMPLE = [
    { from: 'News <news@acme.com>', subject: 'Weekly product update' },
    { from: 'deals@acme.com', subject: 'Weekly product deals' },
    { from: 'Bob <bob@other.com>', subject: 'lunch' },
    { from: 'sales@acme.com', subject: 'product launch' },
  ];

  it('ranks top sender domains by frequency', () => {
    const r = recommendKeywords(SAMPLE, { minCount: 1 });
    expect(r.topDomains[0]).toMatchObject({ domain: 'acme.com', count: 3 });
    expect(r.sampled).toBe(4);
  });

  it('mines frequent subject terms and bigrams above minCount', () => {
    const r = recommendKeywords(SAMPLE, { minCount: 2 });
    const terms = r.subjectTerms.map((t) => t.term);
    expect(terms).toContain('product');          // appears 3x
    expect(terms).toContain('weekly product');   // bigram appears 2x
    expect(terms).not.toContain('lunch');         // only once → below minCount
  });

  it('flags candidates already covered by existing keywords', () => {
    const r = recommendKeywords(SAMPLE, { minCount: 1, existingKeywords: ['acme.com'] });
    expect(r.topDomains.find((d) => d.domain === 'acme.com')?.covered).toBe(true);
    expect(r.suggestedKeywords).not.toContain('acme.com'); // covered → not suggested
  });

  it('drops stopwords and pure numbers from subject terms', () => {
    const r = recommendKeywords([{ from: 'a@x.com', subject: 'Your 2026 the order' }, { from: 'b@x.com', subject: 'your 2026 order' }], { minCount: 2 });
    const terms = r.subjectTerms.map((t) => t.term);
    expect(terms).toContain('order');
    expect(terms).not.toContain('your'); // stopword
    expect(terms).not.toContain('2026'); // pure number
  });
});
