// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for extractPdfText (#89).

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { extractPdfText } from './pdf-text.js';

describe('extractPdfText (#89)', () => {
  it('degrades gracefully on a non-PDF buffer (returns error, never throws)', async () => {
    const r = await extractPdfText(Buffer.from('this is not a pdf'));
    expect(r.text).toBe('');
    expect(r.pages).toBe(0);
    expect(r.truncated).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('extracts text from a real PDF', async () => {
    // Use a sample PDF shipped with the pdf-parse dependency.
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('pdf-parse/package.json'));
    const sample = path.join(pkgDir, 'test', 'data', '01-valid.pdf');
    if (!existsSync(sample)) return; // dependency layout changed — skip rather than fail
    const r = await extractPdfText(readFileSync(sample));
    expect(r.error).toBeUndefined();
    expect(r.pages).toBeGreaterThan(0);
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('truncates at maxChars', async () => {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('pdf-parse/package.json'));
    const sample = path.join(pkgDir, 'test', 'data', '01-valid.pdf');
    if (!existsSync(sample)) return;
    const r = await extractPdfText(readFileSync(sample), 5);
    expect(r.text.length).toBeLessThanOrEqual(5);
    expect(r.truncated).toBe(true);
  });
});
