// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// spam-scan-tools.ts — combined spam scan over a block of messages (#261 follow-up).
//
// One route that runs each message against UserCheck (sender reputation) and/or
// the DNS firewall (malicious link/domain), with the per-user allow/deny lists
// applied as overrides (allowlisted → never spam; denylisted → always spam).
// Optional safe action: move flagged messages to a Junk folder (default) or flag
// them — never a bare \Deleted.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { DatabaseService } from '../services/database-service.js';
import { ImapService } from '../services/imap-service.js';
import { UserCheckService, SpamCheckCriteria, normalizeAddress } from '../services/usercheck-service.js';
import { DnsFirewallService } from '../services/dns-firewall-service.js';
import { DomainExtractionService } from '../services/domain-extraction-service.js';
import { AddressListService } from '../services/address-list-service.js';
import { resolveUserOrThrow } from '../utils/user-resolver.js';

export function spamScanTools(server: McpServer, imapService: ImapService, db: DatabaseService): void {
  const userCheck = new UserCheckService(db);
  const dnsFirewall = new DnsFirewallService(db);
  const domainExtractor = new DomainExtractionService();
  const lists = new AddressListService(db);

  server.registerTool('imap_scan_messages_spam', {
    description:
      'Scan a block of messages for spam against UserCheck (sender reputation), the DNS firewall (malicious ' +
      'link/domain), or both, and apply the per-user allow/deny lists (allowlisted sender is never flagged; ' +
      'denylisted is always flagged). Returns a per-message verdict with reasons. Optional action moves flagged ' +
      'messages to a Junk folder (safe/reversible) or flags them — it never sets \\Deleted.',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username)'),
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder to scan (default: INBOX)'),
      uids: z.array(z.number()).optional().describe('Specific UIDs; omit to scan the most recent messages'),
      limit: z.number().optional().default(50).describe('Max most-recent messages when uids omitted (default 50, cap 200)'),
      engines: z.enum(['usercheck', 'dns', 'both']).optional().default('both').describe('Which anti-spam engine(s) to run'),
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
    const runUserCheck = args.engines === 'usercheck' || args.engines === 'both';
    const runDns = args.engines === 'dns' || args.engines === 'both';
    const criteria: SpamCheckCriteria = {
      checkDisposable: args.checkDisposable, checkBlocklisted: args.checkBlocklisted,
      checkRoleAccount: args.checkRoleAccount, checkMx: args.checkMx, allowPublicDomains: args.allowPublicDomains,
    };

    const all = await imapService.searchEmails(accountId, folder, {});
    const msgs = args.uids && args.uids.length > 0
      ? all.filter((m) => args.uids!.includes(m.uid))
      : [...all].sort((a, b) => b.uid - a.uid).slice(0, cap);

    const warnings: string[] = [];
    let ucEnabled = runUserCheck;
    const results: any[] = [];

    for (const m of msgs) {
      const from = m.from || '';
      const addr = normalizeAddress(from);
      const reasons: string[] = [];
      let spam = false;
      let source: string[] = [];

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
      if (ucEnabled && addr) {
        try {
          const cached = args.useCache !== false ? await userCheck.getCachedResult(addr) : null;
          const uc = cached ?? await (async () => { const r = await userCheck.checkEmail(userId, addr, criteria); await userCheck.cacheResult(addr, r); return r; })();
          if (uc.isSpam) { spam = true; source.push('usercheck'); reasons.push(`sender: ${uc.spamReason || 'flagged by UserCheck'}`); }
        } catch (e: any) {
          ucEnabled = false; // usually a missing/invalid API key — stop hammering it
          warnings.push(`UserCheck disabled: ${e?.message || e}. Add a key with imap_add_usercheck_key.`);
        }
      }

      // 3. DNS firewall (malicious link/domain in the message).
      let blockedDomains: string[] = [];
      if (runDns) {
        try {
          const content = await imapService.getEmailContent(accountId, folder, m.uid);
          const domains = domainExtractor.extractAllDomains(content);
          const scan = await dnsFirewall.validateMessageDomains(m.uid, domains);
          if (!scan.isSafe) { spam = true; source.push('dns'); blockedDomains = scan.blockedDomains; reasons.push(`malicious domain(s): ${scan.blockedDomains.join(', ')}`); }
        } catch (e: any) {
          reasons.push(`dns-scan error: ${e?.message || e}`);
        }
      }

      results.push({ uid: m.uid, from, subject: m.subject, verdict: spam ? 'spam' : 'clean', source: source.length ? source : ['clean'], reasons, ...(blockedDomains.length ? { blockedDomains } : {}) });
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
          engines: args.engines ?? 'both',
          summary: { scanned: results.length, spam: spamUids.length, clean: results.length - spamUids.length },
          action: actionResult,
          messages: results,
          ...(warnings.length ? { warnings } : {}),
        }, null, 2)
      }]
    };
  }));
}
