// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// spam-scan-tools.ts — combined spam scan over a block of messages (#264).
//
// One route that runs each message through up to three independently-toggleable
// engines and applies the per-user allow/deny lists as overrides:
//   - checkSender  : UserCheck sender reputation (needs an API key)
//   - checkDomains : DNS firewall over every domain (headers + body)
//   - checkLinks   : LinkCheck — enumerate every embedded URL, check each link's
//                    domain against the DNS firewall, and flag risky patterns
//                    (URL shorteners, raw-IP hosts)
// Allowlisted senders are never flagged; denylisted senders are always flagged.
// Optional action moves flagged messages to a Junk folder (safe/reversible) or
// flags them — never a bare \Deleted.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { DatabaseService } from '../services/database-service.js';
import { ImapService } from '../services/imap-service.js';
import { EmailContent } from '../types/index.js';
import { UserCheckService, SpamCheckCriteria, normalizeAddress } from '../services/usercheck-service.js';
import { DnsFirewallService } from '../services/dns-firewall-service.js';
import { DomainExtractionService } from '../services/domain-extraction-service.js';
import { AddressListService } from '../services/address-list-service.js';
import { resolveUserOrThrow } from '../utils/user-resolver.js';

// Well-known URL shorteners — links through these hide the real destination.
const URL_SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'rb.gy', 'shorturl.at', 'tiny.cc', 'lnkd.in',
]);

export function isRawIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':'); // IPv4 or IPv6-ish
}

/** Extract every embedded http(s) URL from a message body (text + html). */
export function extractLinks(content: EmailContent): string[] {
  const urls: string[] = [];
  const seen = new Set();
  const re = /https?:\/\/[^\s"'<>()]+/gi;
  for (const s of [content.textContent, content.htmlContent]) {
    if (!s) continue;
    for (const m of s.matchAll(re)) {
      const url = m[0].replace(/[.,;:)\]}>'"]+$/, ''); // strip trailing punctuation
      if (!seen.has(url)) { seen.add(url); urls.push(url); }
    }
  }
  return urls;
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export function spamScanTools(server: McpServer, imapService: ImapService, db: DatabaseService): void {
  const userCheck = new UserCheckService(db);
  const dnsFirewall = new DnsFirewallService(db);
  const domainExtractor = new DomainExtractionService();
  const lists = new AddressListService(db);

  server.registerTool('imap_scan_messages_spam', {
    description:
      'Scan a block of messages for spam with up to three independently-toggleable engines and the per-user ' +
      'allow/deny lists. checkSender = UserCheck sender reputation; checkDomains = DNS firewall over all domains; ' +
      'checkLinks = LinkCheck over every embedded URL (flags DNS-blocked link domains, URL shorteners, and raw-IP ' +
      'hosts). Allowlisted senders are never flagged; denylisted always. Optional action moves flagged messages to ' +
      'a Junk folder (safe/reversible) or flags them — it never sets \\Deleted.',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username)'),
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder to scan (default: INBOX)'),
      uids: z.array(z.number()).optional().describe('Specific UIDs; omit to scan the most recent messages'),
      limit: z.number().optional().default(50).describe('Max most-recent messages when uids omitted (default 50, cap 200)'),
      checkSender: z.boolean().optional().default(true).describe('Run UserCheck sender-reputation (needs an API key)'),
      checkDomains: z.boolean().optional().default(true).describe('Run the DNS firewall over all domains (headers + body)'),
      checkLinks: z.boolean().optional().default(true).describe('Run LinkCheck over every embedded URL'),
      action: z.enum(['report', 'move', 'flag']).optional().default('report').describe("Action on flagged messages: report (default), move (to spamFolder), or flag (\\Flagged)"),
      spamFolder: z.string().optional().default('Junk').describe('Destination folder for action=move (default: Junk)'),
      useCache: z.boolean().optional().default(true).describe('Use the UserCheck spam_cache (default true)'),
      checkDisposable: z.boolean().optional().default(true),
      checkBlocklisted: z.boolean().optional().default(true),
      checkRoleAccount: z.boolean().optional().default(true),
      checkMx: z.boolean().optional().default(true),
      allowPublicDomains: z.boolean().optional().default(true),
    },
  }, withErrorHandling(async (args) => {
    const userId = resolveUserOrThrow(db, args.userId);
    const { accountId, folder } = args;
    const cap = Math.min(args.limit ?? 50, 200);
    const runSender = args.checkSender !== false;
    const runDomains = args.checkDomains !== false;
    const runLinks = args.checkLinks !== false;
    const needBody = runDomains || runLinks;
    const criteria: SpamCheckCriteria = {
      checkDisposable: args.checkDisposable, checkBlocklisted: args.checkBlocklisted,
      checkRoleAccount: args.checkRoleAccount, checkMx: args.checkMx, allowPublicDomains: args.allowPublicDomains,
    };

    if (!runSender && !runDomains && !runLinks) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, message: 'All engines are disabled — enable at least one of checkSender / checkDomains / checkLinks.' }, null, 2) }] };
    }

    const all = await imapService.searchEmails(accountId, folder, {});
    const msgs = args.uids && args.uids.length > 0
      ? all.filter((m) => args.uids!.includes(m.uid))
      : [...all].sort((a, b) => b.uid - a.uid).slice(0, cap);

    const warnings: string[] = [];
    let senderEnabled = runSender;
    const results: any[] = [];

    for (const m of msgs) {
      const from = m.from || '';
      const addr = normalizeAddress(from);
      const reasons: string[] = [];
      const source: string[] = [];
      let spam = false;

      // 1. Allow/deny overrides win outright.
      const listed = lists.check(userId, from);
      if (listed.verdict === 'allow') {
        results.push({ uid: m.uid, from, subject: m.subject, verdict: 'clean', source: ['allowlist'], matched: listed.matchedValue });
        continue;
      }
      if (listed.verdict === 'deny') {
        results.push({ uid: m.uid, from, subject: m.subject, verdict: 'spam', source: ['denylist'], matched: listed.matchedValue });
        continue;
      }

      // 2. UserCheck (sender reputation).
      if (senderEnabled && addr) {
        try {
          const cached = args.useCache !== false ? await userCheck.getCachedResult(addr) : null;
          const uc = cached ?? await (async () => { const r = await userCheck.checkEmail(userId, addr, criteria); await userCheck.cacheResult(addr, r); return r; })();
          if (uc.isSpam) { spam = true; source.push('usercheck'); reasons.push(`sender: ${uc.spamReason || 'flagged by UserCheck'}`); }
        } catch (e: any) {
          senderEnabled = false;
          warnings.push(`UserCheck disabled: ${e?.message || e}. Add a key with imap_add_usercheck_key.`);
        }
      }

      // Fetch the body once for the domain/link engines.
      let content: EmailContent | null = null;
      if (needBody) {
        try { content = await imapService.getEmailContent(accountId, folder, m.uid); }
        catch (e: any) { reasons.push(`body-fetch error: ${e?.message || e}`); }
      }

      // 3. DNS firewall over all domains (headers + body).
      let blockedDomains: string[] = [];
      if (runDomains && content) {
        try {
          const scan = await dnsFirewall.validateMessageDomains(m.uid, domainExtractor.extractAllDomains(content));
          if (!scan.isSafe) { spam = true; source.push('dns'); blockedDomains = scan.blockedDomains; reasons.push(`malicious domain(s): ${scan.blockedDomains.join(', ')}`); }
        } catch (e: any) { reasons.push(`dns-scan error: ${e?.message || e}`); }
      }

      // 4. LinkCheck — every embedded URL.
      const links: Array<{ url: string; host: string | null; blocked: boolean; suspicious: string[] }> = [];
      if (runLinks && content) {
        const seen = new Set();
        for (const url of extractLinks(content)) {
          const host = hostOf(url);
          let blocked = false;
          const suspicious: string[] = [];
          if (host) {
            if (!seen.has(host)) {
              seen.add(host);
              try { blocked = (await dnsFirewall.checkDomain(host)).isBlocked; } catch { /* ignore */ }
            } else {
              blocked = links.find((l) => l.host === host)?.blocked ?? false;
            }
            if (isRawIpHost(host)) suspicious.push('raw-ip-host');
            if (URL_SHORTENERS.has(host)) suspicious.push('url-shortener');
          }
          links.push({ url, host, blocked, suspicious });
        }
        const blockedLinks = links.filter((l) => l.blocked);
        const shortened = links.filter((l) => l.suspicious.length > 0);
        if (blockedLinks.length) { spam = true; source.push('linkcheck'); reasons.push(`${blockedLinks.length} link(s) to blocked domains`); }
        if (shortened.length) reasons.push(`${shortened.length} suspicious link(s) (shortener/raw-IP)`);
      }

      results.push({
        uid: m.uid, from, subject: m.subject,
        verdict: spam ? 'spam' : 'clean',
        source: source.length ? source : ['clean'],
        reasons,
        ...(blockedDomains.length ? { blockedDomains } : {}),
        ...(runLinks ? { links } : {}),
      });
    }

    // Action on flagged messages.
    const spamUids = results.filter((r) => r.verdict === 'spam').map((r) => r.uid);
    let actionResult: any = { action: args.action ?? 'report', affected: 0 };
    if (spamUids.length > 0 && args.action === 'move') {
      await imapService.bulkMoveEmails(accountId, folder, spamUids, args.spamFolder ?? 'Junk');
      actionResult = { action: 'move', to: args.spamFolder ?? 'Junk', affected: spamUids.length };
    } else if (spamUids.length > 0 && args.action === 'flag') {
      await imapService.bulkMarkEmails(accountId, folder, spamUids, 'flagged');
      actionResult = { action: 'flag', affected: spamUids.length };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          folder,
          engines: { sender: runSender, domains: runDomains, links: runLinks },
          summary: { scanned: results.length, spam: spamUids.length, clean: results.length - spamUids.length },
          action: actionResult,
          messages: results,
          ...(warnings.length ? { warnings } : {}),
        }, null, 2)
      }]
    };
  }));
}
