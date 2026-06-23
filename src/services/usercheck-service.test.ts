// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for normalizeAddress + the cache-aware / deduping checkEmailsBatch
// (one UserCheck call per unique sending address). The HTTP/cache layer is
// stubbed via a subclass so no network or DB is touched.

import { describe, expect, it } from 'vitest';
import { UserCheckService, normalizeAddress } from './usercheck-service.js';

describe('normalizeAddress', () => {
  it('extracts the address from a display-name header and lowercases it', () => {
    expect(normalizeAddress('Alice Example <A@X.com>')).toBe('a@x.com');
  });
  it('passes through a bare address (lowercased, trimmed)', () => {
    expect(normalizeAddress('  B@Y.COM ')).toBe('b@y.com');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeAddress('')).toBe('');
  });
});

// Stub the API + cache layers; count actual "API" calls.
class FakeUserCheck extends UserCheckService {
  apiCalls: string[] = [];
  store = new Map<string, any>();
  constructor() { super({} as any); }
  async checkEmail(_userId: string, email: string): Promise<any> {
    this.apiCalls.push(email);
    return { email, normalized_email: email, domain: email.split('@')[1] ?? '', isSpam: email.includes('spam'), spamScore: email.includes('spam') ? 1 : 0 };
  }
  async getCachedResult(email: string): Promise<any> { return this.store.get(email) ?? null; }
  async cacheResult(email: string, result: any): Promise<void> { this.store.set(email, result); }
}

describe('UserCheckService.checkEmailsBatch — one call per unique sender', () => {
  it('normalizes and dedupes so each address is checked once', async () => {
    const svc = new FakeUserCheck();
    const out = await svc.checkEmailsBatch('u', ['Alice <a@x.com>', 'a@x.com', 'A@X.COM', 'bob@y.com']);
    expect(svc.apiCalls.sort()).toEqual(['a@x.com', 'bob@y.com']); // 2 calls, not 4
    expect(out.map((r) => r.email).sort()).toEqual(['a@x.com', 'bob@y.com']);
  });

  it('consults the cache: cached senders cost no API call', async () => {
    const svc = new FakeUserCheck();
    svc.store.set('a@x.com', { email: 'a@x.com', isSpam: true, spamScore: 1 });
    const out = await svc.checkEmailsBatch('u', ['a@x.com', 'bob@y.com']);
    expect(svc.apiCalls).toEqual(['bob@y.com']); // a@x.com served from cache
    expect(out.find((r) => r.email === 'a@x.com')?.cached).toBe(true);
    expect(out.find((r) => r.email === 'bob@y.com')?.cached).toBe(false);
  });

  it('write-through caches freshly checked senders', async () => {
    const svc = new FakeUserCheck();
    await svc.checkEmailsBatch('u', ['c@z.com']);
    expect(svc.store.has('c@z.com')).toBe(true);
    // Second run hits the cache — no new API call.
    await svc.checkEmailsBatch('u', ['c@z.com']);
    expect(svc.apiCalls).toEqual(['c@z.com']); // still just the one
  });

  it('useCache:false bypasses the cache', async () => {
    const svc = new FakeUserCheck();
    svc.store.set('a@x.com', { email: 'a@x.com', isSpam: false, spamScore: 0 });
    await svc.checkEmailsBatch('u', ['a@x.com'], {}, { useCache: false });
    expect(svc.apiCalls).toEqual(['a@x.com']); // ignored the cache
  });

  it('returns empty for empty / all-blank input', async () => {
    const svc = new FakeUserCheck();
    expect(await svc.checkEmailsBatch('u', [])).toEqual([]);
    expect(await svc.checkEmailsBatch('u', ['', '   '])).toEqual([]);
    expect(svc.apiCalls).toEqual([]);
  });
});
