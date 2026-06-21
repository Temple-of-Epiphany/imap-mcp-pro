// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for DnsFirewallService.testQuad9 (#65). The protected quad9Lookup is
// overridden in a subclass so the logic is exercised without a real DoH socket.

import { describe, expect, it } from 'vitest';
import { DnsFirewallService } from './dns-firewall-service.js';

type Lookup = { status: number; answers: number } | null;

class StubDnsFirewall extends DnsFirewallService {
  constructor(private lookups: Record<string, Lookup>) {
    // db is only used via getDefaultDnsFirewallProvider → return null to hit the Quad9 fallback.
    super({ getDefaultDnsFirewallProvider: () => null } as any);
  }
  protected async quad9Lookup(domain: string): Promise<Lookup> {
    return domain in this.lookups ? this.lookups[domain] : null;
  }
}

const RESOLVED = { status: 0, answers: 2 };
const NXDOMAIN = { status: 3, answers: 0 };

describe('DnsFirewallService.testQuad9 (#65)', () => {
  it('reports ACTIVE when the control resolves and the blocked domain does not', async () => {
    const svc = new StubDnsFirewall({ 'www.google.com': RESOLVED, 'malware.wicar.org': NXDOMAIN });
    const out = await svc.testQuad9();
    expect(out.quad9Active).toBe(true);
    expect(out.reachable).toBe(true);
    expect(out.control).toMatchObject({ domain: 'www.google.com', resolved: true, status: 0 });
    expect(out.blocked).toMatchObject({ domain: 'malware.wicar.org', resolved: false, status: 3 });
    expect(out.message).toMatch(/ACTIVE/);
  });

  it('is not active (and says so) when the blocked-test domain also resolves', async () => {
    const svc = new StubDnsFirewall({ 'www.google.com': RESOLVED, 'malware.wicar.org': RESOLVED });
    const out = await svc.testQuad9();
    expect(out.quad9Active).toBe(false);
    expect(out.blocked.resolved).toBe(true);
    expect(out.message).toMatch(/also resolved/);
  });

  it('flags an unreachable endpoint', async () => {
    const svc = new StubDnsFirewall({}); // every lookup → null
    const out = await svc.testQuad9();
    expect(out.reachable).toBe(false);
    expect(out.quad9Active).toBe(false);
    expect(out.message).toMatch(/Could not reach/);
  });

  it('flags a control domain that fails to resolve (misconfiguration)', async () => {
    const svc = new StubDnsFirewall({ 'www.google.com': NXDOMAIN, 'malware.wicar.org': NXDOMAIN });
    const out = await svc.testQuad9();
    expect(out.quad9Active).toBe(false);
    expect(out.message).toMatch(/control domain .* did not resolve/);
  });

  it('honors custom control and blocked domains', async () => {
    const svc = new StubDnsFirewall({ 'clean.example': RESOLVED, 'bad.example': NXDOMAIN });
    const out = await svc.testQuad9({ controlDomain: 'clean.example', blockedTestDomain: 'bad.example' });
    expect(out.quad9Active).toBe(true);
    expect(out.control.domain).toBe('clean.example');
    expect(out.blocked.domain).toBe('bad.example');
  });
});
