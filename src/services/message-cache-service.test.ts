/**
 * Tests for message-cache-service.ts internal helpers.
 *
 * Coverage: extractDomain, extractHeader.
 *
 * Class methods (syncFolder, searchByFromDomain, etc.) require live
 * DatabaseService + ImapService dependencies and are exercised end-to-end
 * by scripts/smoke-test-cache.ts against a real IMAP account. Unit-testing
 * them would require deep mocking of node:sqlite + ImapFlow, with low
 * confidence-per-line. The smoke test is the trade-off.
 */

import { describe, expect, it } from 'vitest';
import { extractDomain, extractHeader } from './message-cache-service.js';

describe('extractDomain', () => {
  it('returns the domain for a normal address', () => {
    expect(extractDomain('alice@example.com')).toBe('example.com');
  });

  it('lowercases the result', () => {
    expect(extractDomain('Alice@EXAMPLE.com')).toBe('example.com');
  });

  it('handles subdomains', () => {
    expect(extractDomain('a@mail.corp.example.com')).toBe('mail.corp.example.com');
  });

  it('uses the last @ for addresses with multiple @ characters', () => {
    expect(extractDomain('"weird@local"@example.com')).toBe('example.com');
  });

  it('returns null for null input', () => {
    expect(extractDomain(null)).toBeNull();
  });

  it('returns null for an address with no @', () => {
    expect(extractDomain('no-at-sign')).toBeNull();
  });

  it('returns null for an address ending in @', () => {
    expect(extractDomain('user@')).toBeNull();
  });
});

describe('extractHeader', () => {
  it('returns null for an empty buffer', () => {
    expect(extractHeader(Buffer.from(''), 'List-Unsubscribe')).toBeNull();
  });

  it('returns null for an undefined buffer', () => {
    expect(extractHeader(undefined, 'List-Unsubscribe')).toBeNull();
  });

  it('finds a single-line header', () => {
    const buf = Buffer.from('List-Unsubscribe: <https://example.com/u?id=42>\r\n');
    expect(extractHeader(buf, 'List-Unsubscribe')).toBe('<https://example.com/u?id=42>');
  });

  it('is case-insensitive on header name', () => {
    const buf = Buffer.from('list-unsubscribe: <https://example.com/u>\r\n');
    expect(extractHeader(buf, 'List-Unsubscribe')).toBe('<https://example.com/u>');
  });

  it('handles folded continuation lines (RFC 5322 unfolding)', () => {
    const buf = Buffer.from(
      'List-Unsubscribe: <https://example.com/u?id=42>,\r\n' +
        ' <mailto:unsub@example.com?subject=unsub>\r\n'
    );
    expect(extractHeader(buf, 'List-Unsubscribe')).toBe(
      '<https://example.com/u?id=42>, <mailto:unsub@example.com?subject=unsub>'
    );
  });

  it('skips other headers and finds the target', () => {
    const buf = Buffer.from(
      'From: a@b.com\r\n' +
        'Subject: hi\r\n' +
        'List-Unsubscribe: <https://x.example/u>\r\n'
    );
    expect(extractHeader(buf, 'List-Unsubscribe')).toBe('<https://x.example/u>');
  });

  it('returns null when the header is absent', () => {
    const buf = Buffer.from('From: a@b.com\r\nSubject: hi\r\n');
    expect(extractHeader(buf, 'List-Unsubscribe')).toBeNull();
  });

  it('does not match a header name that is a prefix of another', () => {
    const buf = Buffer.from('List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n');
    expect(extractHeader(buf, 'List-Unsubscribe')).toBeNull();
  });
});
