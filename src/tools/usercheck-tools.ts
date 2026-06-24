/**
 * UserCheck Anti-SPAM MCP Tools
 *
 * MCP tools for SPAM detection using UserCheck API
 * Supports single and bulk email checking with custom criteria
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date: 2025-11-06
 * Version: 1.0.0
 *
 * Related Issues: #3, #17, #18, #32
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { resolveUserOrThrow } from '../utils/user-resolver.js';
import { UserCheckService, SpamCheckCriteria, normalizeAddress } from '../services/usercheck-service.js';
import { DatabaseService } from '../services/database-service.js';
import { ImapService } from '../services/imap-service.js';
import { BulkJobService } from '../services/bulk-job-service.js';
import { BULK_RUNNERS, runJobWithBudget, RunnerDeps } from './bulk-runners.js';

export function userCheckTools(server: McpServer, db: DatabaseService, imapService: ImapService, jobs: BulkJobService): void {
  const userCheck = new UserCheckService(db);
  const runnerDeps: RunnerDeps = { imapService, userCheck };
  const DEFAULT_BUDGET_MS = 30000;

  // ===== UserCheck API Key Management Tools =====

  server.registerTool('imap_add_usercheck_key', {
    description: 'Add a UserCheck API key for a user (admin or own user only)',
    inputSchema: {
      userId: z.string().describe('User ID — either canonical user_id UUID or username from the users table. Call imap_list_users for valid values.'),
      apiKey: z.string().describe('UserCheck API key from https://usercheck.com/register?platform=api'),
      dailyLimit: z.number().optional().default(1000).describe('Daily API call limit (default: 1000)'),
      notes: z.string().optional().describe('Optional notes about this API key')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, apiKey, dailyLimit, notes }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    // Issue #83: Use DatabaseService method instead of direct SQL
    const result = db.createUserCheckKey({
      user_id: userId,
      api_key: apiKey,
      daily_limit: dailyLimit,
      notes
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          keyId: result.id,
          message: `UserCheck API key added for user ${userId}`,
          dailyLimit
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_get_usercheck_key', {
    description: 'Get UserCheck API key information for a user',
    inputSchema: {
      userId: z.string().describe('User ID — either canonical user_id UUID or username from the users table.')
    }
  }, withErrorHandling(async ({ userId: userIdRaw }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    // Issue #83: Use DatabaseService method instead of direct SQL
    const keys = db.listUserCheckKeys(userId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          userId,
          keys: keys.map((k: any) => ({
            id: k.id,
            apiKey: k.api_key.substring(0, 8) + '...' + k.api_key.substring(k.api_key.length - 4), // Masked
            isActive: k.is_active === 1,
            dailyLimit: k.daily_limit,
            dailyUsage: k.daily_usage,
            usageResetAt: k.usage_reset_at,
            lastUsed: k.last_used,
            createdAt: k.created_at,
            notes: k.notes
          }))
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_delete_usercheck_key', {
    description: 'Delete a UserCheck API key',
    inputSchema: {
      keyId: z.number().describe('UserCheck key ID to delete')
    }
  }, withErrorHandling(async ({ keyId }) => {
    // Issue #83: Use DatabaseService method instead of direct SQL
    db.deleteUserCheckKey(keyId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `UserCheck API key ${keyId} deleted`
        }, null, 2)
      }]
    };
  }));

  // ===== SPAM Detection Tools =====

  server.registerTool('imap_check_email_spam', {
    description: 'Check a single email address against UserCheck for spam',
    inputSchema: {
      userId: z.string().describe('User ID — either canonical user_id UUID or username from the users table (must have active UserCheck API key).'),
      email: z.string().email().describe('Email address to check'),
      checkDisposable: z.boolean().optional().default(true).describe('Flag disposable email addresses'),
      checkBlocklisted: z.boolean().optional().default(true).describe('Flag blocklisted email addresses'),
      checkRoleAccount: z.boolean().optional().default(true).describe('Flag role-based email accounts'),
      checkMx: z.boolean().optional().default(true).describe('Check MX records'),
      allowPublicDomains: z.boolean().optional().default(true).describe('Allow public email domains'),
      useCache: z.boolean().optional().default(true).describe('Use cached results if available')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, email, checkDisposable, checkBlocklisted, checkRoleAccount, checkMx, allowPublicDomains, useCache }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    const criteria: SpamCheckCriteria = {
      checkDisposable,
      checkBlocklisted,
      checkRoleAccount,
      checkMx,
      allowPublicDomains
    };

    // Check cache first if enabled
    if (useCache) {
      const cached = await userCheck.getCachedResult(email);
      if (cached) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              cached: true,
              result: cached
            }, null, 2)
          }]
        };
      }
    }

    // Check with UserCheck API
    const result = await userCheck.checkEmail(userId, email, criteria);

    // Cache the result
    await userCheck.cacheResult(email, result);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          cached: false,
          result
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_check_domain', {
    description: 'Check a domain against UserCheck for spam/validity',
    inputSchema: {
      userId: z.string().describe('User ID — either canonical user_id UUID or username from the users table (must have active UserCheck API key).'),
      domain: z.string().describe('Domain to validate (e.g., example.com)'),
      checkDisposable: z.boolean().optional().default(true).describe('Flag disposable/temporary domains'),
      checkBlocklisted: z.boolean().optional().default(true).describe('Flag blocklisted domains'),
      checkMx: z.boolean().optional().default(true).describe('Check MX records'),
      allowPublicDomains: z.boolean().optional().default(true).describe('Allow public email domains')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, domain, checkDisposable, checkBlocklisted, checkMx, allowPublicDomains }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    const criteria: SpamCheckCriteria = {
      checkDisposable,
      checkBlocklisted,
      checkMx,
      allowPublicDomains
    };

    // Check domain with UserCheck API
    const result = await userCheck.checkDomain(userId, domain, criteria);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          result
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_check_emails_spam_bulk', {
    description: 'Check multiple email addresses against UserCheck for spam (max 1000)',
    inputSchema: {
      userId: z.string().describe('User ID — either canonical user_id UUID or username from the users table (must have active UserCheck API key).'),
      emails: z.array(z.string().email()).max(1000).describe('Array of email addresses to check'),
      checkDisposable: z.boolean().optional().default(true).describe('Flag disposable email addresses'),
      checkBlocklisted: z.boolean().optional().default(true).describe('Flag blocklisted email addresses'),
      checkRoleAccount: z.boolean().optional().default(true).describe('Flag role-based email accounts'),
      checkMx: z.boolean().optional().default(true).describe('Check MX records'),
      allowPublicDomains: z.boolean().optional().default(true).describe('Allow public email domains'),
      useCache: z.boolean().optional().default(true).describe('Use cached results if available')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, emails, checkDisposable, checkBlocklisted, checkRoleAccount, checkMx, allowPublicDomains, useCache }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    const criteria: SpamCheckCriteria = {
      checkDisposable,
      checkBlocklisted,
      checkRoleAccount,
      checkMx,
      allowPublicDomains
    };

    // checkEmailsBatch normalizes + dedupes addresses and consults the cache
    // per address (write-through on miss), so each unique sender costs at most
    // one UserCheck call. The per-result `cached` flag reflects cache vs API.
    const results = await userCheck.checkEmailsBatch(userId, emails, criteria, { useCache });

    // Separate spam from legitimate
    const spam = results.filter(r => r.isSpam);
    const legitimate = results.filter(r => !r.isSpam);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          summary: {
            total: results.length,
            spam: spam.length,
            legitimate: legitimate.length,
            cached: results.filter(r => r.cached).length
          },
          spam,
          legitimate
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_check_folder_spam', {
    description: 'Check all emails in a folder against UserCheck and return spam messages',
    inputSchema: {
      userId: z.string().describe('User ID — either canonical user_id UUID or username from the users table (must have active UserCheck API key).'),
      accountId: z.string().describe('IMAP account ID'),
      folder: z.string().default('INBOX').describe('Folder to check'),
      limit: z.number().optional().default(100).describe('Maximum emails to check'),
      checkDisposable: z.boolean().optional().default(true).describe('Flag disposable email addresses'),
      checkBlocklisted: z.boolean().optional().default(true).describe('Flag blocklisted email addresses'),
      checkRoleAccount: z.boolean().optional().default(true).describe('Flag role-based email accounts'),
      checkMx: z.boolean().optional().default(true).describe('Check MX records'),
      allowPublicDomains: z.boolean().optional().default(true).describe('Allow public email domains'),
      useCache: z.boolean().optional().default(true).describe('Use cached results if available')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, accountId, folder, limit, checkDisposable, checkBlocklisted, checkRoleAccount, checkMx, allowPublicDomains, useCache }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    const criteria: SpamCheckCriteria = {
      checkDisposable,
      checkBlocklisted,
      checkRoleAccount,
      checkMx,
      allowPublicDomains
    };

    // Search for emails in folder (get all emails, then limit)
    const allEmails = await imapService.searchEmails(accountId, folder, {});
    const emails = allEmails.slice(0, limit);

    // Unique, normalized senders (one check per address regardless of how many
    // messages they sent or how the From header is formatted), capped at 1000.
    const senderEmails = [...new Set(emails.map(e => normalizeAddress(e.from)))].slice(0, 1000);

    // Cache-aware batch: cached senders cost no API call (write-through on miss).
    const spamChecks = await userCheck.checkEmailsBatch(userId, senderEmails, criteria, { useCache });

    // Map normalized-address -> result; look up each message by its normalized sender.
    const spamMap = new Map(spamChecks.map(r => [r.email, r]));
    const spamMessages = emails.filter(e => {
      const check = spamMap.get(normalizeAddress(e.from));
      return check && check.isSpam;
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          folder,
          summary: {
            totalMessages: emails.length,
            uniqueSenders: senderEmails.length,
            spamSenders: spamChecks.filter(r => r.isSpam).length,
            spamMessages: spamMessages.length
          },
          spamMessages: spamMessages.map(e => ({
            uid: e.uid,
            from: e.from,
            subject: e.subject,
            date: e.date,
            spamInfo: spamMap.get(normalizeAddress(e.from))
          }))
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_scan_account_spam', {
    description: 'Scan entire IMAP account for spam using UserCheck, checking all folders',
    inputSchema: {
      userId: z.string().describe('User ID — either canonical user_id UUID or username from the users table (must have active UserCheck API key).'),
      accountId: z.string().describe('IMAP account ID'),
      maxEmailsPerFolder: z.number().optional().default(100).describe('Max emails to check per folder'),
      checkDisposable: z.boolean().optional().default(true).describe('Flag disposable email addresses'),
      checkBlocklisted: z.boolean().optional().default(true).describe('Flag blocklisted email addresses'),
      checkRoleAccount: z.boolean().optional().default(true).describe('Flag role-based email accounts'),
      checkMx: z.boolean().optional().default(true).describe('Check MX records'),
      allowPublicDomains: z.boolean().optional().default(true).describe('Allow public email domains'),
      useCache: z.boolean().optional().default(true).describe('Use cached results if available (a sender is checked once across folders/runs within the cache TTL)')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, accountId, maxEmailsPerFolder, checkDisposable, checkBlocklisted, checkRoleAccount, checkMx, allowPublicDomains, useCache }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    const criteria: SpamCheckCriteria = {
      checkDisposable,
      checkBlocklisted,
      checkRoleAccount,
      checkMx,
      allowPublicDomains
    };

    // Get all folders
    const folders = await imapService.listFolders(accountId);

    const folderResults = [];
    let totalSpamMessages = 0;
    const allSpamSenders = new Set<string>();

    for (const folder of folders) {
      try {
        // Search for emails in folder (get all emails, then limit)
        const allEmails = await imapService.searchEmails(accountId, folder.name, {});
        const emails = allEmails.slice(0, maxEmailsPerFolder);

        if (emails.length === 0) continue;

        // Unique, normalized senders for this folder (capped at 1000). The
        // cache makes a sender seen in an earlier folder/run cost no API call,
        // so cross-folder duplicates are checked once per TTL.
        const senderEmails = [...new Set(emails.map(e => normalizeAddress(e.from)))].slice(0, 1000);

        const spamChecks = await userCheck.checkEmailsBatch(userId, senderEmails, criteria, { useCache });

        const spamMap = new Map(spamChecks.map(r => [r.email, r]));
        const spamMessages = emails.filter(e => {
          const check = spamMap.get(normalizeAddress(e.from));
          return check && check.isSpam;
        });

        const spamSenders = spamChecks.filter(r => r.isSpam);
        spamSenders.forEach(s => allSpamSenders.add(s.email));

        totalSpamMessages += spamMessages.length;

        folderResults.push({
          folder: folder.name,
          totalMessages: emails.length,
          spamMessages: spamMessages.length,
          spamSenders: spamSenders.length,
          topSpamSenders: spamSenders.slice(0, 5).map(s => ({
            email: s.email,
            spamScore: s.spamScore,
            reason: s.spamReason
          }))
        });
        // (Caching is handled write-through inside checkEmailsBatch.)
      } catch (error) {
        folderResults.push({
          folder: folder.name,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          accountId,
          summary: {
            foldersScanned: folders.length,
            totalSpamMessages,
            uniqueSpamSenders: allSpamSenders.size
          },
          folderResults
        }, null, 2)
      }]
    };
  }));

  // ---------------------------------------------------------------------------
  // Async / resumable variants (Issue #117). Each starts a persistent job and
  // runs it with a 30s sync budget: if the scan finishes in time you get the
  // full summary; otherwise a job_id to poll (imap_bulk_job_status), cancel
  // (imap_bulk_job_cancel), or resume (imap_bulk_job_resume). UserCheck is
  // called once per unique sender; spam_cache short-circuits repeats.
  // The original synchronous tools above are unchanged.
  // ---------------------------------------------------------------------------

  server.registerTool('imap_scan_account_spam_start', {
    description:
      'Start a resumable account-wide spam scan (UserCheck) as a tracked job. Scans every folder, dedupes ' +
      'senders to unique addresses, and checks each once (cached senders cost no API call). Returns the full ' +
      'summary if it completes within ~30s, otherwise a jobId to poll/resume/cancel. Unlike imap_scan_account_spam ' +
      'this has no 1000-sender cap and survives interruption.',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username) with an active UserCheck API key'),
      accountId: z.string().describe('IMAP account ID'),
      maxEmailsPerFolder: z.number().optional().default(100).describe('Max emails to sample per folder for sender extraction'),
      checkDisposable: z.boolean().optional().default(true),
      checkBlocklisted: z.boolean().optional().default(true),
      checkRoleAccount: z.boolean().optional().default(true),
      checkMx: z.boolean().optional().default(true),
      allowPublicDomains: z.boolean().optional().default(true),
      useCache: z.boolean().optional().default(true).describe('Skip senders already in spam_cache (default true)'),
      budgetMs: z.number().optional().default(30000).describe('Sync wait budget before returning a jobId (default 30000)'),
    },
  }, withErrorHandling(async (args) => {
    const userId = resolveUserOrThrow(db, args.userId);
    const params = {
      accountId: args.accountId, maxEmailsPerFolder: args.maxEmailsPerFolder,
      checkDisposable: args.checkDisposable, checkBlocklisted: args.checkBlocklisted,
      checkRoleAccount: args.checkRoleAccount, checkMx: args.checkMx,
      allowPublicDomains: args.allowPublicDomains, useCache: args.useCache,
    };
    const runner = BULK_RUNNERS.imap_scan_account_spam;
    const items = await runner.deriveItems(userId, params, runnerDeps);
    const jobId = jobs.createJob({ userId, accountId: args.accountId, toolName: 'imap_scan_account_spam', params, totalItems: items.length });
    return runJobWithBudget(jobs, jobId, items,
      (k) => runner.processOne(userId, k, params, runnerDeps),
      (jid) => runner.summarize(jid, params, jobs),
      args.budgetMs ?? DEFAULT_BUDGET_MS);
  }));

  server.registerTool('imap_check_emails_spam_bulk_start', {
    description:
      'Start a resumable bulk spam check of a list of email addresses (UserCheck) as a tracked job. Dedupes ' +
      'to unique addresses, one check each (cache-first). Returns the full summary if done within ~30s, else a ' +
      'jobId to poll/resume/cancel.',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username) with an active UserCheck API key'),
      accountId: z.string().optional().default('').describe('Optional account ID for grouping the job'),
      emails: z.array(z.string()).min(1).describe('Email addresses to check'),
      checkDisposable: z.boolean().optional().default(true),
      checkBlocklisted: z.boolean().optional().default(true),
      checkRoleAccount: z.boolean().optional().default(true),
      checkMx: z.boolean().optional().default(true),
      allowPublicDomains: z.boolean().optional().default(true),
      useCache: z.boolean().optional().default(true),
      budgetMs: z.number().optional().default(30000),
    },
  }, withErrorHandling(async (args) => {
    const userId = resolveUserOrThrow(db, args.userId);
    const params = {
      emails: args.emails, checkDisposable: args.checkDisposable, checkBlocklisted: args.checkBlocklisted,
      checkRoleAccount: args.checkRoleAccount, checkMx: args.checkMx,
      allowPublicDomains: args.allowPublicDomains, useCache: args.useCache,
    };
    const runner = BULK_RUNNERS.imap_check_emails_spam_bulk;
    const items = await runner.deriveItems(userId, params, runnerDeps);
    const jobId = jobs.createJob({ userId, accountId: args.accountId || 'n/a', toolName: 'imap_check_emails_spam_bulk', params, totalItems: items.length });
    return runJobWithBudget(jobs, jobId, items,
      (k) => runner.processOne(userId, k, params, runnerDeps),
      (jid) => runner.summarize(jid, params, jobs),
      args.budgetMs ?? DEFAULT_BUDGET_MS);
  }));

  server.registerTool('imap_bulk_job_resume', {
    description:
      'Resume a paused, failed, or cancelled bulk job from where it stopped — only unprocessed items are run ' +
      '(already-checked senders are skipped). Re-derives the work from the job\'s saved params. Returns the full ' +
      'summary if it finishes within ~30s, else the jobId to keep polling.',
    inputSchema: {
      jobId: z.string().describe('Job ID from a *_start tool'),
      budgetMs: z.number().optional().default(30000),
    },
  }, withErrorHandling(async ({ jobId, budgetMs }) => {
    const job = jobs.getJob(jobId);
    if (!job) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'job_not_found', jobId }, null, 2) }], isError: true };
    }
    if (job.status === 'done') {
      return { content: [{ type: 'text', text: JSON.stringify({ jobId, status: 'done', note: 'Job already complete.', summary: job.resultSummary }, null, 2) }] };
    }
    const runner = BULK_RUNNERS[job.toolName];
    if (!runner) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'not_resumable', jobId, toolName: job.toolName }, null, 2) }], isError: true };
    }
    const items = await runner.deriveItems(job.userId, job.params as any, runnerDeps);
    return runJobWithBudget(jobs, jobId, items,
      (k) => runner.processOne(job.userId, k, job.params as any, runnerDeps),
      (jid) => runner.summarize(jid, job.params as any, jobs),
      budgetMs ?? DEFAULT_BUDGET_MS);
  }));
}
