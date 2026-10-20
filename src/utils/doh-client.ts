// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// doh-client.ts — minimal DNS-over-HTTPS client (RFC 8484 wire format over
// HTTP/2) for the DNS firewall (#283).
//
// Why wire format and HTTP/2: Quad9's resolver on dns.quad9.net:443 answers
// RFC 8484 only. The JSON API shape (`?name=…`, `Accept: application/dns-json`)
// gets HTTP 400 "DoH unable to decode BASE64-URL", and any HTTP/1.1 request
// gets HTTP 505. Node's `https.request` is HTTP/1.1, so every query the
// firewall sent since #59 failed, `imap_test_quad9_dns` reported "unreachable",
// and `checkDomain` fell open to "safe" for every domain. Measured 2026-10-20
// with curl: GET `/dns-query?dns=<base64url>` over h2 → 200 application/dns-message.

import http2 from 'http2';

export interface DohAnswer {
  /** DNS RCODE: 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN, … */
  status: number;
  /** Number of records in the answer section. */
  answers: number;
}

export interface DohError {
  error: string;
  httpStatus?: number;
}

/** Build a minimal DNS query (one question, type A, class IN, RD=1, ID=0). ID 0 per RFC 8484 §4.1 cache-friendliness. */
export function buildDnsQuery(domain: string, qtype = 1): Buffer {
  const labels = domain.replace(/\.$/, '').split('.');
  const parts: number[] = [0, 0, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`Invalid DNS label in "${domain}"`);
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0, (qtype >> 8) & 0xff, qtype & 0xff, 0, 1);
  const buf = Buffer.from(parts);
  if (buf.length > 512) throw new Error(`Domain too long: "${domain}"`);
  return buf;
}

/** Read RCODE and ANCOUNT from a DNS response header. Null if too short to be a DNS message. */
export function parseDnsResponse(msg: Buffer): DohAnswer | null {
  if (!Buffer.isBuffer(msg) || msg.length < 12) return null;
  const flags = msg.readUInt16BE(2);
  if ((flags & 0x8000) === 0) return null; // QR bit must be set on a response
  return { status: flags & 0x000f, answers: msg.readUInt16BE(6) };
}

export interface DohQueryOptions {
  /** Hostname (no scheme), e.g. dns.quad9.net. */
  endpoint: string;
  /** Request path (default /dns-query). */
  path?: string;
  timeoutMs?: number;
}

/**
 * Resolve `domain` (type A) through a DoH endpoint. Returns the DNS answer, or
 * a DohError describing the transport/HTTP failure (never throws).
 */
export function dohQuery(domain: string, opts: DohQueryOptions): Promise<DohAnswer | DohError> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const path = `${opts.path ?? '/dns-query'}?dns=${buildDnsQuery(domain).toString('base64url')}`;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: DohAnswer | DohError) => { if (!settled) { settled = true; resolve(v); try { session.close(); } catch { /* closed */ } } };
    const session = http2.connect(`https://${opts.endpoint}`);
    const timer = setTimeout(() => done({ error: `timeout after ${timeoutMs} ms` }), timeoutMs);
    session.on('error', (e: Error) => { clearTimeout(timer); done({ error: e.message }); });
    const req = session.request({
      ':method': 'GET',
      ':path': path,
      'accept': 'application/dns-message',
    });
    let httpStatus = 0;
    const chunks: Buffer[] = [];
    req.on('response', (headers) => { httpStatus = Number(headers[':status'] ?? 0); });
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', (e: Error) => { clearTimeout(timer); done({ error: e.message, httpStatus }); });
    req.on('end', () => {
      clearTimeout(timer);
      if (httpStatus !== 200) return done({ error: `HTTP ${httpStatus}`, httpStatus });
      const parsed = parseDnsResponse(Buffer.concat(chunks));
      done(parsed ?? { error: 'response is not a DNS message', httpStatus });
    });
    req.end();
  });
}

export function isDohError(v: DohAnswer | DohError): v is DohError {
  return (v as DohError).error !== undefined;
}
