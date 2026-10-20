// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// DNS wire-format codec for the DoH client (#283). Transport is exercised live by the manual test plan.
import { describe, expect, it } from 'vitest';
import { buildDnsQuery, parseDnsResponse, isDohError } from './doh-client.js';

describe('buildDnsQuery', () => {
  it('encodes www.google.com as the RFC 1035 question used in the 2026-10-20 curl probe', () => {
    const q = buildDnsQuery('www.google.com');
    expect(q.toString('base64url')).toBe('AAABAAABAAAAAAAAA3d3dwZnb29nbGUDY29tAAABAAE');
    expect(q.readUInt16BE(0)).toBe(0);        // ID 0 (RFC 8484 §4.1)
    expect(q.readUInt16BE(2)).toBe(0x0100);   // RD set
    expect(q.readUInt16BE(4)).toBe(1);        // QDCOUNT
  });
  it('strips a trailing dot and rejects empty or oversize labels', () => {
    expect(buildDnsQuery('example.com.').equals(buildDnsQuery('example.com'))).toBe(true);
    expect(() => buildDnsQuery('a..b')).toThrow(/label/);
    expect(() => buildDnsQuery('x'.repeat(64) + '.com')).toThrow(/label/);
  });
});

describe('parseDnsResponse', () => {
  const hdr = (flags: number, an: number) => { const b = Buffer.alloc(12); b.writeUInt16BE(flags, 2); b.writeUInt16BE(1, 4); b.writeUInt16BE(an, 6); return b; };
  it('reads NOERROR with answers (Quad9 response header from the probe: 8180, ancount 8)', () => {
    expect(parseDnsResponse(hdr(0x8180, 8))).toEqual({ status: 0, answers: 8 });
  });
  it('reads NXDOMAIN (rcode 3, no answers) — the blocked shape', () => {
    expect(parseDnsResponse(hdr(0x8183, 0))).toEqual({ status: 3, answers: 0 });
  });
  it('rejects non-responses and short buffers', () => {
    expect(parseDnsResponse(Buffer.from('DoH unable to decode BASE64-URL'))).toBeNull(); // QR bit clear ('D' = 0x44)
    expect(parseDnsResponse(Buffer.alloc(5))).toBeNull();
    expect(parseDnsResponse(hdr(0x0100, 0))).toBeNull(); // a query, not a response
  });
});

describe('isDohError', () => {
  it('discriminates answers from errors', () => {
    expect(isDohError({ status: 0, answers: 1 })).toBe(false);
    expect(isDohError({ error: 'HTTP 505', httpStatus: 505 })).toBe(true);
  });
});
