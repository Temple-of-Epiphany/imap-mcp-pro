// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for LinkCheck helpers in the combined spam scan (#264).

import { describe, expect, it } from 'vitest';
import { extractLinks, isRawIpHost } from './spam-scan-tools.js';

describe('extractLinks', () => {
  it('pulls http(s) URLs from text and html, deduped, with trailing punctuation stripped', () => {
    const content: any = {
      textContent: 'See https://good.example/path and (http://evil.test/x).',
      htmlContent: '<a href="https://good.example/path">click</a> <a href="http://track.io/abc">t</a>',
    };
    const links = extractLinks(content).sort();
    expect(links).toContain('https://good.example/path');
    expect(links).toContain('http://evil.test/x');
    expect(links).toContain('http://track.io/abc');
    // deduped: the repeated good.example URL appears once
    expect(links.filter((l) => l === 'https://good.example/path')).toHaveLength(1);
  });

  it('returns nothing when there is no body', () => {
    expect(extractLinks({ textContent: '', htmlContent: '' } as any)).toEqual([]);
  });
});

describe('isRawIpHost', () => {
  it('flags raw IPv4/IPv6 hosts', () => {
    expect(isRawIpHost('192.168.0.1')).toBe(true);
    expect(isRawIpHost('2001:db8::1')).toBe(true);
  });
  it('does not flag normal hostnames', () => {
    expect(isRawIpHost('example.com')).toBe(false);
    expect(isRawIpHost('mail.corp.example.com')).toBe(false);
  });
});
