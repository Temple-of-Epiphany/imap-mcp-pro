/**
 * DNS Firewall Service - Quad9 Domain Validation
 *
 * Validates domains against Quad9 DNS firewall for threat detection.
 * Caches results to minimize DNS queries.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Version: 1.0.0
 */

import { DatabaseService } from './database-service.js';
import { dohQuery, isDohError } from '../utils/doh-client.js';

export interface DomainValidationResult {
  domain: string;
  isSafe: boolean;
  isBlocked: boolean;
  provider: string;
  timestamp: Date;
  responseTime: number;
  cached: boolean;
  /** Set when the provider could not be queried; the result then fails open (isSafe=true) and is NOT cached. */
  error?: string;
}

export interface MessageScanResult {
  uid: number;
  isSafe: boolean;
  domains: string[];
  blockedDomains: string[];
  totalDomains: number;
  scanTime: number;
}

export class DnsFirewallService {
  private db: DatabaseService;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly DEFAULT_QUAD9_ENDPOINT = 'dns.quad9.net';
  private readonly DEFAULT_TIMEOUT_MS = 5000;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  /**
   * Get configured provider (or fall back to hardcoded Quad9)
   */
  private getProvider(): {endpoint: string; timeout: number; providerId: string} {
    try {
      const provider = this.db.getDefaultDnsFirewallProvider();
      if (provider && provider.is_enabled && provider.provider_type === 'dns-over-https') {
        return {
          endpoint: provider.api_endpoint || this.DEFAULT_QUAD9_ENDPOINT,
          timeout: provider.timeout_ms || this.DEFAULT_TIMEOUT_MS,
          providerId: provider.provider_id
        };
      }
    } catch (error) {
      console.error('[DnsFirewall] Failed to get provider from DB, using fallback:', error);
    }

    // Fallback to hardcoded Quad9
    return {
      endpoint: this.DEFAULT_QUAD9_ENDPOINT,
      timeout: this.DEFAULT_TIMEOUT_MS,
      providerId: 'quad9'
    };
  }

  /**
   * Check single domain via DNS-over-HTTPS (configured provider or Quad9)
   */
  async checkDomain(domain: string): Promise<DomainValidationResult> {
    const startTime = Date.now();
    const provider = this.getProvider();

    // Check cache first
    const cached = this.getFromCache(domain);
    if (cached) {
      return {
        ...cached,
        responseTime: Date.now() - startTime,
        cached: true
      };
    }

    // Query DNS firewall provider
    const answer = await this.queryProvider(provider.endpoint, domain, provider.timeout);
    const responseTime = Date.now() - startTime;

    if (typeof answer !== 'boolean') {
      // Provider unreachable: fail open (no false positives) but say so and do
      // NOT cache, so the next check retries instead of serving "safe" for 24h.
      return {
        domain,
        isSafe: true,
        isBlocked: false,
        provider: provider.providerId,
        timestamp: new Date(),
        responseTime,
        cached: false,
        error: answer.error,
      };
    }

    const result: DomainValidationResult = {
      domain,
      isSafe: answer,
      isBlocked: !answer,
      provider: provider.providerId,
      timestamp: new Date(),
      responseTime,
      cached: false
    };

    // Cache result
    this.saveToCache(result);

    return result;
  }

  /**
   * Check multiple domains in bulk (with deduplication)
   */
  async checkDomains(domains: string[]): Promise<Map<string, DomainValidationResult>> {
    const results = new Map<string, DomainValidationResult>();
    const uniqueDomains = Array.from(new Set(domains));

    // Process domains in parallel (with reasonable concurrency limit)
    const BATCH_SIZE = 10;
    for (let i = 0; i < uniqueDomains.length; i += BATCH_SIZE) {
      const batch = uniqueDomains.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(domain => this.checkDomain(domain));
      const batchResults = await Promise.all(batchPromises);

      batchResults.forEach(result => {
        results.set(result.domain, result);
      });
    }

    return results;
  }

  /**
   * Validate all domains in a message
   */
  async validateMessageDomains(uid: number, domains: string[]): Promise<MessageScanResult> {
    const startTime = Date.now();

    if (domains.length === 0) {
      return {
        uid,
        isSafe: true,
        domains: [],
        blockedDomains: [],
        totalDomains: 0,
        scanTime: Date.now() - startTime
      };
    }

    // Check all domains
    const validationResults = await this.checkDomains(domains);

    // Find blocked domains
    const blockedDomains: string[] = [];
    for (const [domain, result] of validationResults) {
      if (result.isBlocked) {
        blockedDomains.push(domain);
      }
    }

    // Message is safe only if ALL domains are safe
    const isSafe = blockedDomains.length === 0;

    return {
      uid,
      isSafe,
      domains,
      blockedDomains,
      totalDomains: domains.length,
      scanTime: Date.now() - startTime
    };
  }

  /**
   * Low-level Quad9 DoH lookup returning the raw DNS rcode + answer count
   * (rather than queryProvider's safe/unsafe boolean). Returns null when the
   * provider is unreachable (network error / timeout). Used by testQuad9.
   *
   * `protected` so tests can stub it without opening a real socket.
   */
  protected async quad9Lookup(
    domain: string,
    timeout = this.DEFAULT_TIMEOUT_MS
  ): Promise<{ status: number; answers: number } | null> {
    const endpoint = this.getProvider().endpoint;
    const r = await dohQuery(domain, { endpoint, timeoutMs: timeout });
    if (isDohError(r)) {
      console.error(`[DnsFirewall] DoH lookup of ${domain} via ${endpoint} failed: ${r.error}`);
      return null;
    }
    return r;
  }

  /**
   * Verify Quad9 threat-blocking is active (#65). Resolves a clean control
   * domain (expected to resolve) and a blocked-test domain (expected to be
   * NXDOMAIN/empty when filtering is on) via Quad9 DoH, and reports a derived
   * pass/fail. Since there is no standardized public Quad9 "blocked" test host,
   * `blockedTestDomain` is configurable — pass a domain you know Quad9 blocks
   * for a definitive result.
   */
  async testQuad9(opts?: {
    controlDomain?: string;
    blockedTestDomain?: string;
    timeoutMs?: number;
  }): Promise<{
    quad9Active: boolean;
    reachable: boolean;
    control: { domain: string; resolved: boolean; status: number | null };
    blocked: { domain: string; resolved: boolean; status: number | null };
    endpoint: string;
    message: string;
  }> {
    const controlDomain = opts?.controlDomain || 'www.google.com';
    const blockedTestDomain = opts?.blockedTestDomain || 'malware.wicar.org';
    const timeout = opts?.timeoutMs ?? this.DEFAULT_TIMEOUT_MS;
    const endpoint = this.getProvider().endpoint;

    const [c, b] = await Promise.all([
      this.quad9Lookup(controlDomain, timeout),
      this.quad9Lookup(blockedTestDomain, timeout),
    ]);

    const reachable = c !== null || b !== null;
    const controlResolved = !!c && c.status === 0 && c.answers > 0;
    // "Blocked" = did NOT resolve (NXDOMAIN/empty). A null (unreachable) is not
    // treated as blocked — we can't conclude blocking from a transport failure.
    const blockedResolved = !!b && b.status === 0 && b.answers > 0;
    const quad9Active = reachable && controlResolved && !blockedResolved;

    let message: string;
    if (!reachable) {
      message = `Could not reach the Quad9 DoH endpoint (${endpoint}). Check network/DNS configuration.`;
    } else if (!controlResolved) {
      message = `Quad9 reached but the control domain "${controlDomain}" did not resolve — the endpoint may be misconfigured.`;
    } else if (quad9Active) {
      message = `Quad9 filtering appears ACTIVE: "${controlDomain}" resolved and the blocked-test domain "${blockedTestDomain}" did not. For a definitive result, pass a blockedTestDomain you know Quad9 blocks.`;
    } else {
      message = `Quad9 is reachable and resolving, but the blocked-test domain "${blockedTestDomain}" also resolved, so threat blocking could not be confirmed. Override blockedTestDomain with a domain you know Quad9 blocks.`;
    }

    return {
      quad9Active,
      reachable,
      control: { domain: controlDomain, resolved: controlResolved, status: c ? c.status : null },
      blocked: { domain: blockedTestDomain, resolved: blockedResolved, status: b ? b.status : null },
      endpoint,
      message,
    };
  }

  /**
   * Query the DNS-over-HTTPS provider (RFC 8484 wire format over HTTP/2, #283).
   * Returns true if the domain resolves (safe), false if the resolver returned
   * NXDOMAIN / no answers (blocked), or a string describing why the provider
   * could not be queried. The caller decides the fail-open policy.
   */
  private async queryProvider(endpoint: string, domain: string, timeout: number): Promise<boolean | { error: string }> {
    const r = await dohQuery(domain, { endpoint, timeoutMs: timeout });
    if (isDohError(r)) {
      console.error(`[DnsFirewall] DoH query failed for ${domain} via ${endpoint}: ${r.error}`);
      return { error: r.error };
    }
    // Quad9 (and Cloudflare/Google malware filters) answer blocked names with NXDOMAIN or an empty answer section.
    return r.status === 0 && r.answers > 0;
  }

  /**
   * Get domain result from cache
   */
  private getFromCache(domain: string): DomainValidationResult | null {
    try {
      const stmt = this.db['db'].prepare(`
        SELECT * FROM dns_firewall_cache
        WHERE domain = ? AND expires_at > ?
      `);

      const now = Date.now();
      const row = stmt.get(domain, now) as any;

      if (!row) return null;

      return {
        domain: row.domain,
        isSafe: Boolean(row.is_safe),
        isBlocked: Boolean(row.is_blocked),
        provider: row.provider,
        timestamp: new Date(row.checked_at),
        responseTime: 0, // Will be overridden
        cached: true
      };
    } catch (error) {
      console.error('[DnsFirewall] Cache read error:', error);
      return null;
    }
  }

  /**
   * Save domain result to cache
   */
  private saveToCache(result: DomainValidationResult): void {
    try {
      const stmt = this.db['db'].prepare(`
        INSERT OR REPLACE INTO dns_firewall_cache
        (domain, is_safe, is_blocked, provider, checked_at, expires_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      const expiresAt = now + this.CACHE_TTL_MS;

      stmt.run(
        result.domain,
        result.isSafe ? 1 : 0,
        result.isBlocked ? 1 : 0,
        result.provider,
        now,
        expiresAt,
        null
      );
    } catch (error) {
      console.error('[DnsFirewall] Cache write error:', error);
      // Don't throw - caching is optional
    }
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache(): void {
    try {
      const stmt = this.db['db'].prepare('DELETE FROM dns_firewall_cache WHERE expires_at < ?');
      const result = stmt.run(Date.now());
      console.error(`[DnsFirewall] Cleaned up ${result.changes} expired cache entries`);
    } catch (error) {
      console.error('[DnsFirewall] Cache cleanup error:', error);
    }
  }
}
