/**
 * Subscription Management MCP Tools
 *
 * Provides unsubscribe link extraction and subscription management tools
 * Implements Issue #45 Phase 4
 *
 * @author Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
 * @version 0.1.0
 * @date_created 2025-11-07
 * @date_updated 2025-11-07
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ImapService } from '../services/imap-service.js';
import { DatabaseService } from '../services/database-service.js';
import { SmtpService } from '../services/smtp-service.js';
import { UnsubscribeService } from '../services/unsubscribe-service.js';
import { UnsubscribeExecutorService } from '../services/unsubscribe-executor-service.js';
import { withErrorHandling } from '../utils/error-handler.js';
import { sanitizeText, sanitizeUrl } from '../utils/sanitize-content.js';
import { resolveUserOrThrow } from '../utils/user-resolver.js';

export function registerSubscriptionTools(
  server: McpServer,
  imapService: ImapService,
  db: DatabaseService,
  smtpService: SmtpService
): void {
  const unsubscribeService = new UnsubscribeService(db);
  const executorService = new UnsubscribeExecutorService(smtpService);

  /**
   * Read-only bulk extractor: for a block of messages, return links + sender +
   * recipient + subject without writing to the subscriptions DB (#194).
   */
  server.registerTool('imap_get_unsubscribe_links_for', {
    description:
      'Read-only: for a block of messages (explicit UIDs, or a folder scan up to `limit`), return per ' +
      'message the unsubscribe links found in BOTH the List-Unsubscribe header and the body, along with ' +
      'sender, recipient, and subject. Does NOT write to the subscriptions database or send anything; ' +
      'the stored/managed flow is imap_extract_unsubscribe_links, and imap_execute_unsubscribe performs an unsubscribe.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name (default: INBOX)'),
      uids: z.array(z.number()).optional().describe('Specific UIDs to inspect; omit to scan the folder'),
      limit: z.number().optional().default(100).describe('When scanning a folder, max messages to inspect (default 100)'),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, limit }: {
    accountId: string; folder: string; uids?: number[]; limit?: number;
  }) => {
    let targetUids = uids;
    if (!targetUids || targetUids.length === 0) {
      const msgs = await imapService.searchEmails(accountId, folder, {});
      targetUids = msgs.map((m) => m.uid).slice(0, limit ?? 100);
    }

    const raws = await imapService.getRawMessages(accountId, folder, targetUids);
    const messages = [];
    for (const r of raws) {
      const meta = await unsubscribeService.extractWithMeta(r.source);
      const hasUnsubscribe = !!meta.info.unsubscribe_link || !!meta.info.list_unsubscribe_header;
      messages.push({
        uid: r.uid,
        from: sanitizeText(meta.from || r.from || ''),
        to: sanitizeText(meta.to || ''),
        subject: sanitizeText(meta.subject || r.subject || ''),
        hasUnsubscribe,
        unsubscribeLink: meta.info.unsubscribe_link ? sanitizeUrl(meta.info.unsubscribe_link) : undefined,
        method: meta.info.unsubscribe_method,
        listUnsubscribeHeader: meta.info.list_unsubscribe_header
          ? sanitizeText(meta.info.list_unsubscribe_header) : undefined,
      });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          folder,
          scanned: messages.length,
          withUnsubscribe: messages.filter((m) => m.hasUnsubscribe).length,
          messages,
        }, null, 2)
      }]
    };
  }));

  /**
   * Extract unsubscribe links from emails in a folder
   */
  server.registerTool('imap_extract_unsubscribe_links', {
    description:
      'Scan a folder for unsubscribe links and store them for subscription management. ' +
      'Header-first: reads each message\'s List-Unsubscribe header cheaply (no body download) and only ' +
      'falls back to a full-body fetch when a message has no header and scanBodies is on. Bounded by an ' +
      'internal time budget (maxDurationMs) so it always returns — on timeout it returns a partial result ' +
      'with truncated:true and nextUid for resuming via afterUid. For large folders, paginate with afterUid.',
    inputSchema: {
      userId: z.string().describe('User ID (either canonical user_id UUID or username from the users table). Call imap_list_users for valid values.'),
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      limit: z.number().optional().default(100).describe('Max emails to process (default: 100)'),
      olderThan: z.number().optional().describe('Optional: Only process emails older than N days'),
      afterUid: z.number().optional().describe('Resume: only process messages with UID greater than this (pass the previous run\'s nextUid).'),
      scanBodies: z.boolean().optional().default(true).describe('On a header miss, fetch the full body to find in-body unsubscribe links (slower). Default true.'),
      maxDurationMs: z.number().optional().default(50000).describe('Internal time budget in ms; on exceed, return a partial result with truncated:true (default 50000).'),
    }
  }, withErrorHandling(async ({ userId: userIdRaw, accountId, folder, limit, olderThan, afterUid, scanBodies, maxDurationMs }: {
    userId: string; accountId: string; folder: string; limit?: number; olderThan?: number;
    afterUid?: number; scanBodies?: boolean; maxDurationMs?: number;
  }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    const startTime = Date.now();
    const budgetMs = maxDurationMs ?? 50000;
    const wantBodyScan = scanBodies !== false;

    // Build search criteria
    const searchCriteria: any = {};
    if (olderThan) {
      const date = new Date();
      date.setDate(date.getDate() - olderThan);
      searchCriteria.before = date;
    }

    // Search for emails, apply resume cursor + limit. Process in ascending UID
    // order so nextUid/afterUid paging is monotonic.
    const emails = (await imapService.searchEmails(accountId, folder, searchCriteria))
      .filter((e) => afterUid == null || e.uid > afterUid)
      .sort((a, b) => a.uid - b.uid);
    const limitedEmails = limit ? emails.slice(0, limit) : emails;

    // One cheap streaming fetch of just the List-Unsubscribe header lines for
    // the whole set — avoids a full-body download per message (#131).
    const headerRows = await imapService.getUnsubscribeHeaders(
      accountId, folder, limitedEmails.map((e) => e.uid)
    );
    const headerByUid = new Map(headerRows.map((r) => [r.uid, r]));

    const results = {
      processed: 0,
      linksFound: 0,
      linksStored: 0,
      bodyScans: 0,
      errors: 0,
      emails: [] as any[],
      // Per-message error reasons so the tool surface is debuggable on its
      // own, without digging through MCP server stderr (issue #130).
      failedLinks: [] as Array<{ uid: number; from: string; reason: string }>
    };

    let truncated = false;
    let nextUid: number | null = null;

    for (const email of limitedEmails) {
      // Time budget (#131): stop before starting more work and hand back a
      // partial result the caller can resume from.
      if (Date.now() - startTime > budgetMs) {
        truncated = true;
        nextUid = email.uid - 1; // resume with afterUid = nextUid → reprocesses from here
        break;
      }

      try {
        results.processed++;
        const row = headerByUid.get(email.uid);
        const from = row?.from || email.from;
        const subject = row?.subject || email.subject;
        const date = row?.date ?? (email.date ? new Date(email.date) : undefined);

        // Header-first: parse the cheap header block (trailing blank line makes
        // it a valid header-only RFC822 fragment for the parser).
        let unsubscribeInfo = row?.headerBytes
          ? await unsubscribeService.extractFromEmail(Buffer.concat([row.headerBytes, Buffer.from('\r\n')]))
          : {};

        // Fallback: only when the header yielded nothing and body scan is on.
        if (!unsubscribeInfo.unsubscribe_link && !unsubscribeInfo.list_unsubscribe_header && wantBodyScan) {
          results.bodyScans++;
          const emailContent = await imapService.getEmailContent(accountId, folder, email.uid, false);
          const emailSource = [emailContent.textContent || '', emailContent.htmlContent || ''].join('\n\n');
          unsubscribeInfo = await unsubscribeService.extractFromEmail(emailSource);
        }

        // v2.17.6 (#143): sanitize before storing so future-stored URLs
        // are free of parsing residue (`>™`, `]`, control chars).
        const cleanLink = sanitizeUrl(unsubscribeInfo.unsubscribe_link);
        const cleanHeader = sanitizeText(unsubscribeInfo.list_unsubscribe_header, 500);
        const cleanSubject = sanitizeText(subject, 200);

        if (cleanLink || cleanHeader) {
          results.linksFound++;

          unsubscribeService.storeUnsubscribeLink({
            user_id: userId,
            account_id: accountId,
            folder,
            uid: email.uid,
            sender_email: from,
            sender_name: from.split('<')[0].trim(),
            subject: cleanSubject ?? undefined,
            message_date: date,
            unsubscribe_info: {
              ...unsubscribeInfo,
              unsubscribe_link: cleanLink ?? undefined,
              list_unsubscribe_header: cleanHeader ?? undefined,
            },
          });

          results.linksStored++;

          results.emails.push({
            uid: email.uid,
            from,
            subject: cleanSubject,
            date,
            unsubscribe_link: cleanLink,
            unsubscribe_method: unsubscribeInfo.unsubscribe_method,
            has_list_unsubscribe_header: !!cleanHeader,
          });
        }
      } catch (error: any) {
        results.errors++;
        const reason = error?.message ?? String(error);
        results.failedLinks.push({
          uid: email.uid,
          from: email.from,
          reason: reason.slice(0, 500),       // cap to keep response reasonable
        });
        console.error(`[SubscriptionTools] Error processing email ${email.uid}:`, error);
      }
    }

    const elapsed = Date.now() - startTime;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: {
            processed: results.processed,
            candidates: limitedEmails.length,
            linksFound: results.linksFound,
            linksStored: results.linksStored,
            bodyScans: results.bodyScans,
            errors: results.errors,
            elapsed_ms: elapsed,
            truncated,
            ...(truncated ? { nextUid, hint: `Re-run with afterUid: ${nextUid} to continue.` } : {}),
          },
          emails: results.emails,
          // Only include when non-empty to avoid noise on healthy runs.
          ...(results.failedLinks.length > 0 ? { failedLinks: results.failedLinks } : {})
        }, null, 2)
      }]
    };
  }));

  /**
   * Get subscription summary for a user
   */
  server.registerTool('imap_get_subscription_summary', {
    description: 'Get aggregated subscription summary. Shows all senders with unsubscribe links, email counts, categories, and unsubscribe status. Filter by category or unsubscribed status.',
    inputSchema: {
      userId: z.string().describe('User ID (either canonical user_id UUID or username from the users table). Call imap_list_users for valid values.'),
      category: z.enum(['marketing', 'newsletter', 'promotional', 'transactional', 'other']).optional().describe('Filter by category'),
      unsubscribed: z.boolean().optional().describe('Filter by unsubscribe status'),
      sortBy: z.enum(['last_seen', 'total_emails', 'sender_email']).optional().default('last_seen').describe('Sort by field')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, category, unsubscribed, sortBy }: {
    userId: string; category?: string; unsubscribed?: boolean; sortBy?: string
  }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    let subscriptions = unsubscribeService.getSubscriptionSummary(userId, { category, unsubscribed });

    // Sort results
    if (sortBy === 'total_emails') {
      subscriptions.sort((a, b) => b.total_emails - a.total_emails);
    } else if (sortBy === 'sender_email') {
      subscriptions.sort((a, b) => a.sender_email.localeCompare(b.sender_email));
    }
    // last_seen is default from query

    const summary = {
      total: subscriptions.length,
      by_category: {} as Record<string, number>,
      unsubscribed_count: subscriptions.filter(s => s.unsubscribed).length,
      active_count: subscriptions.filter(s => !s.unsubscribed).length
    };

    // Count by category
    for (const sub of subscriptions) {
      summary.by_category[sub.category] = (summary.by_category[sub.category] || 0) + 1;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary,
          subscriptions: subscriptions.map(s => ({
            sender_email: s.sender_email,
            sender_name: s.sender_name,
            sender_domain: s.sender_domain,
            total_emails: s.total_emails,
            first_seen: s.first_seen,
            last_seen: s.last_seen,
            category: s.category,
            unsubscribed: s.unsubscribed,
            unsubscribed_at: s.unsubscribed_at,
            unsubscribe_link: s.unsubscribe_link,
            unsubscribe_method: s.unsubscribe_method,
            notes: s.notes
          }))
        }, null, 2)
      }]
    };
  }));

  /**
   * Mark subscription as unsubscribed
   */
  server.registerTool('imap_mark_subscription_unsubscribed', {
    description: 'Mark a sender as unsubscribed in the database. Records timestamp. Useful for tracking which lists you have already unsubscribed from.',
    inputSchema: {
      userId: z.string().describe('User ID (either canonical user_id UUID or username from the users table). Call imap_list_users for valid values.'),
      senderEmail: z.string().describe('Sender email address to mark as unsubscribed')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, senderEmail }: { userId: string; senderEmail: string }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    unsubscribeService.markAsUnsubscribed(userId, senderEmail);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          message: `Marked ${senderEmail} as unsubscribed`,
          sender_email: senderEmail,
          user_id: userId
        }, null, 2)
      }]
    };
  }));

  /**
   * Update subscription category
   */
  server.registerTool('imap_update_subscription_category', {
    description: 'Update the category of a subscription (marketing, newsletter, promotional, transactional, other). Helps organize subscriptions.',
    inputSchema: {
      userId: z.string().describe('User ID (either canonical user_id UUID or username from the users table). Call imap_list_users for valid values.'),
      senderEmail: z.string().describe('Sender email address'),
      category: z.enum(['marketing', 'newsletter', 'promotional', 'transactional', 'other']).describe('New category')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, senderEmail, category }: {
    userId: string; senderEmail: string; category: 'marketing' | 'newsletter' | 'promotional' | 'transactional' | 'other'
  }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    db.updateSubscriptionCategory(userId, senderEmail, category);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          message: `Updated ${senderEmail} category to ${category}`,
          sender_email: senderEmail,
          category,
          user_id: userId
        }, null, 2)
      }]
    };
  }));

  /**
   * Update subscription notes
   */
  server.registerTool('imap_update_subscription_notes', {
    description: 'Add or update notes for a subscription. Useful for tracking why you subscribed, unsubscribe difficulty, etc.',
    inputSchema: {
      userId: z.string().describe('User ID (either canonical user_id UUID or username from the users table). Call imap_list_users for valid values.'),
      senderEmail: z.string().describe('Sender email address'),
      notes: z.string().describe('Notes text')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, senderEmail, notes }: {
    userId: string; senderEmail: string; notes: string
  }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    db.updateSubscriptionNotes(userId, senderEmail, notes);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          message: `Updated notes for ${senderEmail}`,
          sender_email: senderEmail,
          user_id: userId
        }, null, 2)
      }]
    };
  }));

  /**
   * Get all unsubscribe links for a specific sender
   */
  server.registerTool('imap_get_unsubscribe_links', {
    description: 'Get all extracted unsubscribe links from emails. Filter by account or sender. Shows individual email details with unsubscribe links.',
    inputSchema: {
      userId: z.string().describe('User ID (either canonical user_id UUID or username from the users table). Call imap_list_users for valid values.'),
      accountId: z.string().optional().describe('Filter by account ID'),
      senderEmail: z.string().optional().describe('Filter by sender email')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, accountId, senderEmail }: {
    userId: string; accountId?: string; senderEmail?: string
  }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    const links = unsubscribeService.getUnsubscribeLinks(userId, { account_id: accountId, sender_email: senderEmail });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: links.length,
          // v2.17.6 (#143): sanitize on the read path so legacy data
          // stored before sanitization is also clean for the LLM.
          links: links.map(link => ({
            id: link.id,
            account_id: link.account_id,
            folder: link.folder,
            uid: link.uid,
            sender_email: link.sender_email,
            subject: sanitizeText(link.subject, 200),
            message_date: link.message_date,
            unsubscribe_link: sanitizeUrl(link.unsubscribe_link),
            list_unsubscribe_header: sanitizeText(link.list_unsubscribe_header, 500),
            extracted_at: link.extracted_at,
          })),
        }, null, 2)
      }]
    };
  }));

  /**
   * List unsubscribe candidates with detailed information
   * Issue #47
   */
  server.registerTool('imap_list_unsubscribe_candidates', {
    description: 'List all subscriptions with unsubscribe links. Shows sender, subject, link, method, and email count. Filter by category or unsubscribed status. Perfect for reviewing before executing unsubscribes.',
    inputSchema: {
      userId: z.string().describe('User ID (either canonical user_id UUID or username from the users table). Call imap_list_users for valid values.'),
      category: z.enum(['marketing', 'newsletter', 'promotional', 'transactional', 'other']).optional().describe('Filter by category'),
      unsubscribed: z.boolean().optional().describe('Filter by unsubscribe status (default: show all)'),
      sortBy: z.enum(['last_seen', 'total_emails', 'sender_email']).optional().default('total_emails').describe('Sort by field')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, category, unsubscribed, sortBy }: {
    userId: string; category?: string; unsubscribed?: boolean; sortBy?: string
  }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    let subscriptions = unsubscribeService.getSubscriptionSummary(userId, { category, unsubscribed });

    // Only show subscriptions with unsubscribe links
    subscriptions = subscriptions.filter(s => s.unsubscribe_link);

    // Sort results
    if (sortBy === 'total_emails') {
      subscriptions.sort((a, b) => b.total_emails - a.total_emails);
    } else if (sortBy === 'sender_email') {
      subscriptions.sort((a, b) => a.sender_email.localeCompare(b.sender_email));
    } else if (sortBy === 'last_seen') {
      subscriptions.sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime());
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          total: subscriptions.length,
          // v2.17.6 (#143): sanitize on the read path. unsubscribe_link
          // is the only free-form field exposed here; sender_name and
          // notes are pre-validated.
          candidates: subscriptions.map(s => ({
            sender_email: s.sender_email,
            sender_name: s.sender_name,
            sender_domain: s.sender_domain,
            subject_from_latest: `(${s.total_emails} emails)`,
            unsubscribe_link: sanitizeUrl(s.unsubscribe_link),
            unsubscribe_method: s.unsubscribe_method,
            total_emails: s.total_emails,
            category: s.category,
            first_seen: s.first_seen,
            last_seen: s.last_seen,
            unsubscribed: s.unsubscribed,
            unsubscribed_at: s.unsubscribed_at,
            notes: sanitizeText(s.notes, 500),
          })),
        }, null, 2)
      }]
    };
  }));

  /**
   * Execute unsubscribe requests
   * Issue #47
   */
  server.registerTool('imap_execute_unsubscribe', {
    description: 'Execute unsubscribe request for one or more senders. Supports HTTP GET/POST and mailto methods. Optional dry-run mode for testing. Updates database with execution results.',
    inputSchema: {
      userId: z.string().describe('User ID (either canonical user_id UUID or username from the users table). Call imap_list_users for valid values.'),
      senderEmails: z.array(z.string()).describe('Array of sender email addresses to unsubscribe from'),
      accountId: z.string().optional().describe('Account ID (required for mailto unsubscribe)'),
      dryRun: z.boolean().optional().default(false).describe('Dry run mode - validate but do not execute'),
      method: z.enum(['auto', 'http-get', 'http-post', 'mailto']).optional().default('auto').describe('Unsubscribe method (auto detects from link)')
    }
  }, withErrorHandling(async ({ userId: userIdRaw, senderEmails, accountId, dryRun, method }: {
    userId: string;
    senderEmails: string[];
    accountId?: string;
    dryRun?: boolean;
    method?: 'auto' | 'http-get' | 'http-post' | 'mailto'
  }) => {
    const userId = resolveUserOrThrow(db, userIdRaw);
    const results: any[] = [];

    for (const senderEmail of senderEmails) {
      try {
        // Get subscription info
        const subscriptions = unsubscribeService.getSubscriptionSummary(userId, {});
        const subscription = subscriptions.find(s => s.sender_email === senderEmail);

        if (!subscription) {
          results.push({
            sender_email: senderEmail,
            status: 'error',
            error: 'No subscription found for this sender'
          });
          continue;
        }

        if (!subscription.unsubscribe_link) {
          results.push({
            sender_email: senderEmail,
            status: 'error',
            error: 'No unsubscribe link found for this sender'
          });
          continue;
        }

        if (subscription.unsubscribed) {
          results.push({
            sender_email: senderEmail,
            status: 'skipped',
            message: 'Already marked as unsubscribed',
            unsubscribed_at: subscription.unsubscribed_at
          });
          continue;
        }

        // Dry run mode
        if (dryRun) {
          results.push({
            sender_email: senderEmail,
            status: 'dry-run',
            unsubscribe_link: subscription.unsubscribe_link,
            unsubscribe_method: subscription.unsubscribe_method,
            message: 'Would execute unsubscribe (dry run)'
          });
          continue;
        }

        // Execute unsubscribe based on method
        let result;
        const link = subscription.unsubscribe_link;

        // Auto-detect method if not specified
        let executeMethod = method || 'auto';
        if (executeMethod === 'auto') {
          if (link.startsWith('mailto:')) {
            executeMethod = 'mailto';
          } else if (subscription.unsubscribe_method === 'http') {
            executeMethod = 'http-get';
          } else {
            executeMethod = 'http-get'; // Default fallback
          }
        }

        // Execute based on method
        if (executeMethod === 'mailto') {
          if (!accountId) {
            results.push({
              sender_email: senderEmail,
              status: 'error',
              error: 'accountId required for mailto unsubscribe'
            });
            continue;
          }

          const dbAccount = db.getDecryptedAccount(accountId);
          if (!dbAccount) {
            results.push({
              sender_email: senderEmail,
              status: 'error',
              error: 'Account not found'
            });
            continue;
          }

          // Convert to ImapAccount format
          const account = {
            id: dbAccount.account_id,
            name: dbAccount.name,
            host: dbAccount.host,
            port: dbAccount.port,
            user: dbAccount.username,
            password: dbAccount.password,
            tls: dbAccount.tls,
            smtp: dbAccount.smtp_host ? {
              host: dbAccount.smtp_host,
              port: dbAccount.smtp_port!,
              secure: dbAccount.smtp_secure || false,
              user: dbAccount.smtp_username,
              password: dbAccount.smtp_password
            } : undefined
          };

          result = await executorService.executeMailtoUnsubscribe(link, account as any);
        } else if (executeMethod === 'http-post') {
          result = await executorService.executeHttpPostUnsubscribe(link);
        } else {
          // http-get
          result = await executorService.executeHttpUnsubscribe(link);
        }

        // Update database with result
        if (result.success) {
          db.updateSubscriptionUnsubscribeResult(
            userId,
            senderEmail,
            'success',
            result.details || 'Unsubscribe executed successfully',
            true
          );
        } else {
          db.updateSubscriptionUnsubscribeResult(
            userId,
            senderEmail,
            'failed',
            result.error || 'Unsubscribe failed',
            false
          );
        }

        results.push({
          sender_email: senderEmail,
          status: result.success ? 'success' : 'failed',
          method: result.method,
          statusCode: result.statusCode,
          details: result.details,
          error: result.error
        });
      } catch (error: any) {
        results.push({
          sender_email: senderEmail,
          status: 'error',
          error: error.message || 'Unknown error'
        });

        // Record error in database
        db.updateSubscriptionUnsubscribeResult(
          userId,
          senderEmail,
          'error',
          error.message || 'Unknown error',
          false
        );
      }
    }

    const summary = {
      total: results.length,
      succeeded: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
      errors: results.filter(r => r.status === 'error').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      dry_run: dryRun || false
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary,
          results
        }, null, 2)
      }]
    };
  }));
}
