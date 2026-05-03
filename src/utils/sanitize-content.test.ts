/**
 * Tests for sanitize-content.ts.
 *
 * Covers the defensive sanitizers added in v2.17.6 (#143) for unsubscribe
 * link/subject/header content that gets returned to LLM clients.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeText, sanitizeUrl } from './sanitize-content.js';

describe('sanitizeUrl', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(sanitizeUrl(null)).toBeNull();
    expect(sanitizeUrl(undefined)).toBeNull();
    expect(sanitizeUrl('')).toBeNull();
  });

  it('passes a clean http URL through unchanged', () => {
    const url = 'http://example.com/unsubscribe?id=42';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('passes a clean https URL through unchanged', () => {
    const url = 'https://example.com/u?token=abcdef';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('passes a mailto URL through unchanged', () => {
    const url = 'mailto:unsubscribe@example.com?subject=unsubscribe';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('strips a trailing trademark glyph (the v2.17.5 bug)', () => {
    expect(sanitizeUrl('http://example.com/u?id=42>™')).toBe('http://example.com/u?id=42');
  });

  it('strips a trailing closing bracket (the original parsing residue)', () => {
    expect(sanitizeUrl('https://example.com/u?token=PT0=]')).toBe('https://example.com/u?token=PT0=');
  });

  it('strips multiple trailing junk characters', () => {
    expect(sanitizeUrl('http://example.com/u]>™')).toBe('http://example.com/u');
  });

  it('strips trailing whitespace and quotes', () => {
    expect(sanitizeUrl('http://example.com/u  ')).toBe('http://example.com/u');
    expect(sanitizeUrl('http://example.com/u"')).toBe('http://example.com/u');
  });

  it('rejects non-URL strings', () => {
    expect(sanitizeUrl('not-a-url')).toBeNull();
    expect(sanitizeUrl('just plain text')).toBeNull();
  });

  it('rejects unsupported schemes (defensive — no javascript:, no data:)', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('data:text/html,<script>')).toBeNull();
    expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
  });

  it('handles a URL with base64 padding correctly (= is valid mid-URL)', () => {
    // Base64 padding `==` should be preserved when it's followed by valid
    // URL chars or end of string.
    expect(sanitizeUrl('https://x.example/u?t=PT0=')).toBe('https://x.example/u?t=PT0=');
  });

  it('returns null when the URL is entirely junk', () => {
    expect(sanitizeUrl(']>™')).toBeNull();
  });
});

describe('sanitizeText', () => {
  it('returns null for null/undefined/empty input', () => {
    expect(sanitizeText(null)).toBeNull();
    expect(sanitizeText(undefined)).toBeNull();
    expect(sanitizeText('')).toBeNull();
  });

  it('passes plain text through unchanged', () => {
    expect(sanitizeText('Re: Remembering 9/11')).toBe('Re: Remembering 9/11');
  });

  it('replaces NUL bytes with space and collapses', () => {
    expect(sanitizeText('Hello\x00World')).toBe('Hello World');
  });

  it('replaces other control characters', () => {
    // \x01 (SOH), \x07 (BEL), \x1B (ESC) — all replaced
    expect(sanitizeText('a\x01b\x07c\x1Bd')).toBe('a b c d');
  });

  it('preserves printable whitespace (tab/newline/CR are kept)', () => {
    // These get collapsed by the trailing whitespace-collapse step but
    // aren't replaced by the control-char step.
    expect(sanitizeText('a\tb\nc\rd')).toBe('a b c d');
  });

  it('caps length at the default 200 chars with ellipsis', () => {
    const long = 'x'.repeat(300);
    const result = sanitizeText(long);
    expect(result?.length).toBe(200);
    expect(result?.endsWith('...')).toBe(true);
  });

  it('respects a custom max length', () => {
    const long = 'abcdefghij';
    const result = sanitizeText(long, 6);
    expect(result).toBe('abc...');
  });

  it('does not truncate when length is under the cap', () => {
    expect(sanitizeText('short', 100)).toBe('short');
  });

  it('returns null when input is only whitespace/control chars', () => {
    expect(sanitizeText('   \t\n  ')).toBeNull();
    expect(sanitizeText('\x00\x01\x02')).toBeNull();
  });

  it('handles unicode (preserves printable non-ASCII)', () => {
    expect(sanitizeText('Café résumé 日本語')).toBe('Café résumé 日本語');
  });
});
