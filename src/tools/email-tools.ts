import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ImapService } from '../services/imap-service.js';
import { DatabaseService } from '../services/database-service.js';
import { SmtpService } from '../services/smtp-service.js';
import { ResultsService, StoredResultRowSummary } from '../services/results-service.js';
import { WorkerPool } from '../utils/worker-pool.js';
import { z } from 'zod';
import { withErrorHandling, AccountNotFoundError } from '../utils/error-handler.js';
import { ImapAccount } from '../types/index.js';
import { humanBytes } from '../utils/human-bytes.js';
import {
  maybeStoreAsHandle,
  ResponseModeSchema,
  StorageTypeSchema,
} from './result-envelope.js';
import { getToolContext } from './tool-context.js';
import { ContextReductionConfig as Cfg } from '../config/context-reduction.js';
import { getOutboxDir, sanitizeFilename } from '../services/attachment-validator.js';
import { MessageExportService } from '../services/message-export-service.js';
import path from 'path';

type ResponseModeOpt = 'auto' | 'inline' | 'handle' | 'file' | undefined;
type StorageTypeOpt = 'temp' | 'persistent' | undefined;

function resolveUserId(db: DatabaseService): string | null {
  try {
    return getToolContext(db).userId;
  } catch {
    return null;
  }
}

function shouldUseHandle(mode: ResponseModeOpt, n: number): boolean {
  if (mode === 'inline') return false;
  if (mode === 'handle' || mode === 'file') return true;
  return n > Cfg.INLINE_THRESHOLD;
}

function capLimit(requested: number | undefined, fallback: number, mode: ResponseModeOpt): number {
  const want = requested ?? fallback;
  const cap = mode === 'inline' || mode === undefined || mode === 'auto'
    ? Cfg.INLINE_LIMIT_CAP
    : Cfg.HANDLE_LIMIT_CAP;
  // For 'auto', we still honor HANDLE cap since we may promote to handle.
  const effectiveCap = mode === 'auto' || mode === undefined
    ? Cfg.HANDLE_LIMIT_CAP
    : cap;
  return Math.min(want, effectiveCap);
}

function toAddress(to: string | string[] | undefined): string | undefined {
  if (to === undefined) return undefined;
  return Array.isArray(to) ? to.join(', ') : to;
}

function toIsoDate(d: Date | string | undefined): string | undefined {
  if (!d) return undefined;
  return d instanceof Date ? d.toISOString() : d;
}

/**
 * Threshold at which row summarisation is worth offloading to a worker.
 * Below this, the postMessage round-trip costs more than the work saved.
 * Raised from 200 after profiling: structured-clone for small objects is
 * cheap but not free, and inline Array.map wins below ~1000 rows.
 */
const WORKER_SUMMARIZE_THRESHOLD = 1000;

/**
 * Build summary rows from raw email objects. Routes through the worker pool
 * for large sets to keep the event loop responsive; falls back to inline
 * summarization when the pool is unset or the batch is small.
 */
async function summarizeEmails(
  emails: any[],
  opts: { fields: 'headers' | 'body' | 'full' },
  workerPool?: WorkerPool
): Promise<StoredResultRowSummary[]> {
  const wantBody = opts.fields !== 'headers';
  if (workerPool && emails.length >= WORKER_SUMMARIZE_THRESHOLD) {
    try {
      const summarized = await workerPool.run<any[]>({
        type: 'summarize-rows',
        payload: { rows: emails, previewChars: Cfg.PREVIEW_CHARS },
      });
      return summarized.map((s, i) => ({
        ...s,
        messageId: emails[i]?.messageId,
        inReplyTo: emails[i]?.inReplyTo,
        ...(wantBody ? {
          textContent: emails[i]?.textContent,
          htmlContent: emails[i]?.htmlContent,
        } : {}),
      })) as StoredResultRowSummary[];
    } catch (e) {
      console.error('[email-tools] worker summarize failed, falling back to inline:', (e as Error)?.message);
    }
  }
  return emails.map((email: any) => ({
    uid: email.uid,
    subject: email.subject,
    from: email.from,
    to: toAddress(email.to),
    date: toIsoDate(email.date),
    flags: email.flags,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    ...(wantBody ? {
      textContent: email.textContent,
      htmlContent: email.htmlContent,
      preview: typeof email.textContent === 'string'
        ? email.textContent.slice(0, Cfg.PREVIEW_CHARS)
        : undefined,
    } : {}),
  }));
}

/**
 * Parse a date-only string (YYYY-MM-DD) as midnight in the local timezone.
 * `new Date("2026-04-01")` interprets the string as UTC midnight, which on
 * non-UTC systems shifts the date by the TZ offset (e.g. -07:00 turns
 * 2026-04-01 into 2026-03-31T17:00Z). For IMAP SINCE/BEFORE semantics the
 * caller intends a calendar day in their own timezone, so parse components
 * explicitly. Full ISO timestamps fall through to the Date constructor.
 *
 * Issue #91.
 */
function parseDateOnly(input: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!m) return new Date(input);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Wrap any payload as a pretty-printed JSON text tool result. */
function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Cap a possibly-undefined body string to keep responses within budget. */
function clip(text: string | undefined, max = 10000): string | undefined {
  return text?.substring(0, max);
}


/** Convert a decrypted DB account row into the ImapAccount shape the services expect. */
function toImapAccount(dbAccount: any): ImapAccount {
  return {
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
      password: dbAccount.smtp_password,
    } : undefined,
  };
}

/** Translate the search tool's flat params into an ImapService SearchCriteria. */
function buildSearchCriteria(raw: Record<string, any>): Record<string, any> {
  const criteria: Record<string, any> = {};
  for (const key of ['from', 'to', 'subject', 'body'] as const) {
    if (raw[key]) criteria[key] = raw[key];
  }
  if (raw.since) criteria.since = parseDateOnly(raw.since);
  if (raw.before) criteria.before = parseDateOnly(raw.before);
  if (raw.unreadOnly !== undefined) criteria.unreadOnly = raw.unreadOnly; // Issue #82
  if (raw.seen !== undefined) criteria.seen = raw.seen;
  if (raw.flagged !== undefined) criteria.flagged = raw.flagged;
  return criteria;
}

export function emailTools(
  server: McpServer,
  imapService: ImapService,
  db: DatabaseService,
  smtpService: SmtpService,
  results?: ResultsService,
  workerPool?: WorkerPool,
  sentFolder?: import('../services/sent-folder-service.js').SentFolderService,
  appendRetry?: import('../services/append-retry-service.js').AppendRetryService,
  staging?: import('../services/attachment-staging-service.js').AttachmentStagingService
): void {
  // Search emails tool
  server.registerTool('imap_search_emails', {
    description:
      'Search for emails in a folder. Default limit is 50. ' +
      'Inline mode (default for small results) caps at 100 to prevent token overflow; ' +
      "set responseMode='handle' or 'file' to return a resultId for larger sets (up to 10,000). " +
      "Use imap_results action='get' to page through handle results.",
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name (default: INBOX)'),
      from: z.string().optional().describe('Search by sender'),
      to: z.string().optional().describe('Search by recipient'),
      subject: z.string().optional().describe('Search by subject'),
      body: z.string().optional().describe('Search in body text'),
      since: z.string().optional().describe('Search emails since date (YYYY-MM-DD)'),
      before: z.string().optional().describe('Search emails before date (YYYY-MM-DD)'),
      seen: z.boolean().optional().describe('Filter by read/unread status'),
      unreadOnly: z.boolean().optional().describe('Show only unread emails (convenience parameter, same as seen=false) - Issue #82'),
      flagged: z.boolean().optional().describe('Filter by flagged status'),
      limit: z.number().optional().default(50).describe(
        'Maximum number of results. Capped at 100 in inline mode, 10,000 in handle/file mode.'
      ),
      responseMode: ResponseModeSchema,
      storageType: StorageTypeSchema,
    }
  }, withErrorHandling(async ({ accountId, folder, limit, responseMode, storageType, ...searchCriteria }) => {
    const effectiveLimit = capLimit(limit, 50, responseMode);
    const criteria = buildSearchCriteria(searchCriteria);

    const messages = await imapService.searchEmails(accountId, folder, criteria);
    const limitedMessages = messages.slice(0, effectiveLimit);

    // Decide: handle or inline?
    const userId = results ? resolveUserId(db) : null;
    if (results && userId && shouldUseHandle(responseMode, limitedMessages.length)) {
      const rows: StoredResultRowSummary[] = limitedMessages.map(m => ({
        uid: m.uid,
        subject: m.subject,
        from: m.from,
        to: toAddress(m.to as any),
        date: toIsoDate(m.date),
        flags: m.flags,
      }));
      return maybeStoreAsHandle({
        userId,
        accountId,
        toolName: 'imap_search_emails',
        folder,
        params: { accountId, folder, limit: effectiveLimit, ...searchCriteria },
        rows,
        responseMode,
        storageType,
        results,
        extra: {
          totalFound: messages.length,
          returned: limitedMessages.length,
        },
      });
    }

    // Inline / backward-compatible response
    const warnings: string[] = [];
    if (limit && limit > Cfg.INLINE_LIMIT_CAP && (responseMode === 'inline' || responseMode === undefined || responseMode === 'auto')) {
      warnings.push(
        `Requested limit ${limit} exceeds inline cap ${Cfg.INLINE_LIMIT_CAP}. ` +
        `Returning ${effectiveLimit} results; pass responseMode='handle' to fetch up to ${Cfg.HANDLE_LIMIT_CAP}.`
      );
    }
    if (messages.length > effectiveLimit) {
      warnings.push(
        `Found ${messages.length} emails but returning only ${effectiveLimit}. ` +
        `Use search criteria to narrow results, or pass responseMode='handle' to store the full set.`
      );
    }
    if (messages.length > 500) {
      warnings.push(`Large folder detected (${messages.length} emails). Consider responseMode='file' for very large sets.`);
    }

    return jsonResult({
      totalFound: messages.length,
      returned: limitedMessages.length,
      warnings: warnings.length > 0 ? warnings : undefined,
      messages: limitedMessages,
    });
  }));

  // Get email content tool
  server.registerTool('imap_get_email', {
    description: 'Get the full content of an email or just headers',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uid: z.number().describe('Email UID'),
      headersOnly: z.boolean().optional().default(false).describe('Fetch only headers without body content (saves bandwidth and context space)')
    }
  }, withErrorHandling(async ({ accountId, folder, uid, headersOnly }) => {
    const email = await imapService.getEmailContent(accountId, folder, uid, headersOnly);

    return jsonResult({
      email: {
        ...email,
        textContent: clip(email.textContent),
        htmlContent: clip(email.htmlContent),
      },
    });
  }));

  // Mark email as read tool
  server.registerTool('imap_mark_as_read', {
    description: 'Mark an email as read',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uid: z.number().describe('Email UID'),
    }
  }, withErrorHandling(async ({ accountId, folder, uid }) => {
    await imapService.markAsRead(accountId, folder, uid);
    return jsonResult({ success: true, message: `Email ${uid} marked as read` });
  }));

  // Mark email as unread tool
  server.registerTool('imap_mark_as_unread', {
    description: 'Mark an email as unread',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uid: z.number().describe('Email UID'),
    }
  }, withErrorHandling(async ({ accountId, folder, uid }) => {
    await imapService.markAsUnread(accountId, folder, uid);
    return jsonResult({ success: true, message: `Email ${uid} marked as unread` });
  }));

  // Delete email tool
  server.registerTool('imap_delete_email', {
    description: 'Delete an email (moves to trash or expunges)',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uid: z.number().describe('Email UID'),
    }
  }, withErrorHandling(async ({ accountId, folder, uid }) => {
    await imapService.deleteEmail(accountId, folder, uid);
    return jsonResult({ success: true, message: `Email ${uid} deleted` });
  }));

  // Get email sizes — find large messages via RFC822.SIZE, no body download (#169)
  server.registerTool('imap_get_email_sizes', {
    description:
      'List messages by size to find large emails — uses RFC822.SIZE (no body download, cheap even on big folders). ' +
      'Scan a whole folder or a specific UID set, optionally filter with minSizeBytes, sorted largest-first. ' +
      'The returned `uids` array can be passed straight to imap_bulk_delete_emails or imap_bulk_move_emails to clear space.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder to scan (default: INBOX)'),
      uids: z.array(z.number()).optional().describe('Specific UIDs to size; omit to scan the whole folder'),
      minSizeBytes: z.number().optional().describe('Only return messages at least this many bytes (e.g. 10485760 = 10 MiB)'),
      limit: z.number().optional().default(100).describe('Max messages to return, largest first (default 100)'),
      order: z.enum(['desc', 'asc']).optional().default('desc').describe("Sort by size: 'desc' = largest first (default), 'asc' = smallest first"),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, minSizeBytes, limit, order }) => {
    const all = await imapService.getEmailSizes(accountId, folder, { uids });
    const matched = minSizeBytes != null ? all.filter(m => m.size >= minSizeBytes) : all.slice();
    matched.sort((a, b) => (order === 'asc' ? a.size - b.size : b.size - a.size));
    const limited = matched.slice(0, limit ?? 100);
    const matchedBytes = matched.reduce((sum, m) => sum + m.size, 0);

    return jsonResult({
      folder,
      scanned: all.length,
      matched: matched.length,
      returned: limited.length,
      totalMatchedBytes: matchedBytes,
      totalMatchedHuman: humanBytes(matchedBytes),
      messages: limited.map(m => ({
        uid: m.uid,
        size: m.size,
        sizeHuman: humanBytes(m.size),
        subject: m.subject,
        from: m.from,
        date: toIsoDate(m.date),
        hasAttachments: m.hasAttachments,
      })),
      // Convenience: ready to pass to imap_bulk_delete_emails / imap_bulk_move_emails.
      uids: limited.map(m => m.uid),
    });
  }));

  // Export messages to standard .eml files on disk — download & save (#170)
  server.registerTool('imap_export_email', {
    description:
      'Export one or more messages to standard .eml files on the server host (download & save). ' +
      '.eml is the raw RFC822 source — lossless, opens in Outlook/Thunderbird/Apple Mail, with attachments ' +
      'and inline images preserved. Files are written under the per-user outbox ' +
      '(~/.imap-mcp/users/{userId}/outbox/exports/), optionally grouped in a named subfolder. All processing is local.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder containing the messages (default: INBOX)'),
      uids: z.array(z.number()).min(1).describe('UIDs of the messages to export'),
      subfolder: z.string().optional().describe('Optional subfolder name under exports/ to group the files (sanitized to a single path segment)'),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, subfolder }) => {
    const userId = resolveUserId(db) ?? 'default';
    const messages = await imapService.getRawMessages(accountId, folder, uids);
    if (messages.length === 0) {
      return jsonResult({ success: false, message: 'No messages found for the given UIDs', folder, requestedUids: uids });
    }

    // Output dir lives under the per-user outbox (always allow-listed). The
    // optional subfolder is reduced to a single sanitized segment so it cannot
    // escape the outbox via path traversal.
    const seg = subfolder ? sanitizeFilename(subfolder).replace(/[\\/]/g, '') : '';
    const outputDir = path.join(getOutboxDir(userId), 'exports', seg);

    const result = await new MessageExportService().exportEml(outputDir, messages);

    return jsonResult({
      success: true,
      format: 'eml',
      folder,
      outputDir: result.outputDir,
      count: result.count,
      totalBytes: result.totalBytes,
      totalSize: humanBytes(result.totalBytes),
      files: result.files.map(f => ({ uid: f.uid, filename: f.filename, path: f.path, size: humanBytes(f.bytes) })),
      requestedUids: uids,
      missingUids: uids.filter(u => !messages.some(m => m.uid === u)),
    });
  }));

  // Bulk delete emails tool
  // AUTO-CHUNKING: Automatically uses chunked processing for >50 UIDs
  server.registerTool('imap_bulk_delete_emails', {
    description: 'Bulk delete multiple emails by UIDs. Automatically uses chunked processing for >50 UIDs to prevent timeouts.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs to delete'),
      expunge: z.boolean().default(false).describe('Permanently expunge deleted emails (default: false, just marks as deleted)'),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, expunge }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to delete',
            deletedCount: 0,
          }, null, 2)
        }]
      };
    }

    const AUTO_CHUNK_THRESHOLD = 50;

    // Automatically use chunked processing for large operations
    if (uids.length > AUTO_CHUNK_THRESHOLD) {
      console.error(`[MCP] Auto-chunking delete: ${uids.length} UIDs > ${AUTO_CHUNK_THRESHOLD} threshold`);

      const result = await imapService.bulkDeleteEmailsChunked(accountId, folder, uids, expunge, {
        chunkSize: 100,
        onProgress: (processed, total, failed) => {
          console.error(`[MCP] Delete progress: ${processed}/${total} processed, ${failed} failed`);
        }
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: result.failed === 0,
            message: `${result.processed} email(s) ${expunge ? 'deleted and expunged' : 'marked as deleted'} (${result.failed} failed, auto-chunked)`,
            deletedCount: result.processed,
            failed: result.failed,
            expunged: expunge,
            chunked: true,
            errors: result.errors.length > 0 ? result.errors : undefined,
          }, null, 2)
        }]
      };
    }

    // Use standard bulk operation for small batches
    await imapService.bulkDeleteEmails(accountId, folder, uids, expunge);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `${uids.length} email(s) ${expunge ? 'deleted and expunged' : 'marked as deleted'}`,
          deletedCount: uids.length,
          expunged: expunge,
        }, null, 2)
      }]
    };
  }));

  // Get latest emails tool
  server.registerTool('imap_get_latest_emails', {
    description:
      'Get the latest emails from a folder. ' +
      "Pass responseMode='handle' to return a resultId for large counts instead of inlining.",
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      count: z.number().default(10).describe('Number of emails to retrieve'),
      responseMode: ResponseModeSchema,
      storageType: StorageTypeSchema,
    }
  }, withErrorHandling(async ({ accountId, folder, count, responseMode, storageType }) => {
    const effectiveCount = capLimit(count, 10, responseMode);
    const messages = await imapService.searchEmails(accountId, folder, {});

    // Sort by date descending and take the latest
    const sortedMessages = messages
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, effectiveCount);

    const userId = results ? resolveUserId(db) : null;
    if (results && userId && shouldUseHandle(responseMode, sortedMessages.length)) {
      const rows: StoredResultRowSummary[] = sortedMessages.map(m => ({
        uid: m.uid,
        subject: m.subject,
        from: m.from,
        to: toAddress(m.to as any),
        date: toIsoDate(m.date),
        flags: m.flags,
      }));
      return maybeStoreAsHandle({
        userId,
        accountId,
        toolName: 'imap_get_latest_emails',
        folder,
        params: { accountId, folder, count: effectiveCount },
        rows,
        responseMode,
        storageType,
        results,
      });
    }

    return jsonResult({ messages: sortedMessages });
  }));

  // Send email tool
  server.registerTool('imap_send_email', {
    description:
      'Send an email via SMTP and (by default) append the message to the IMAP Sent folder. ' +
      'Sent folder resolution: cache → SPECIAL-USE \\Sent flag → provider preset → fallback name probe. ' +
      'Gmail accounts skip the APPEND by default because Gmail server-copies sent messages; ' +
      "pass forceAppendToSent=true to override. Bcc is preserved in the Sent copy per RFC 5322 §3.6.3. " +
      'Attachment input — pick one form per file: ' +
      '(1) `attachments` (inline base64) when the file lives in a sandbox the server cannot read ' +
      '(Claude Desktop Workspace, Claude.ai code sandbox, remote host); ' +
      '(2) `attachmentPaths` when the file is on the same host as this server and inside the ' +
      'configured allow-list; ' +
      '(3) `stagedAttachmentIds` only for files > ~10 MB that need chunked upload.',
    inputSchema: {
      accountId: z.string().describe('Account ID to send from'),
      to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
      subject: z.string().describe('Email subject'),
      text: z.string().optional().describe('Plain text content'),
      html: z.string().optional().describe('HTML content'),
      cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipients'),
      bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipients'),
      replyTo: z.string().optional().describe('Reply-to address'),
      attachments: z.array(z.object({
        filename: z.string().describe('Attachment filename (used as the MIME part filename).'),
        content: z.string().optional().describe(
          'Base64-encoded file bytes. Use this when the file is not on the server host ' +
          '(e.g., generated inside a Claude Desktop Workspace or Claude.ai sandbox).'
        ),
        path: z.string().optional().describe(
          'Absolute file path on the server host. Validated against the same allow-list, ' +
          'dotfile-policy, and size caps as the top-level attachmentPaths field (since v2.17.11 / ' +
          '#147). Prefer the top-level attachmentPaths form for new code — this inline-path field ' +
          'remains for backward compatibility and is targeted for removal in v3.0.'
        ),
        contentType: z.string().optional().describe('MIME type. Auto-detected from filename if omitted.'),
      })).optional().describe(
        'INLINE FORM (preferred when the file is not on the server host). Each attachment carries ' +
        'its bytes inline as base64 in the `content` field. One round-trip, no allow-list, no ' +
        'staging. This is the right choice when the file lives in a Claude Desktop Workspace or ' +
        'Claude.ai sandbox where /mnt/user-data/outputs/ paths are not visible to this server. ' +
        'Practical size ceiling: ~10 MB per request (MCP transport limit). For larger files, use ' +
        'stagedAttachmentIds.'
      ),
      attachmentPaths: z.array(z.string()).optional().describe(
        'PATH FORM (preferred when the file is on the same host as this server). Array of ' +
        'absolute file paths. The server reads, validates, and encodes the files internally. ' +
        'Each path must resolve inside one of the allowed attachment directories (env ' +
        'IMAP_MCP_ALLOWED_ATTACHMENT_DIRS, per-user override in users.allowed_attachment_dirs, ' +
        'or the always-present per-user outbox dir at ~/.imap-mcp/users/{userId}/outbox/ — ' +
        'discoverable via the imap_get_outbox_dir tool). For agent-generated files on this host, ' +
        'write to the outbox dir and reference by absolute path here; no env setup required. ' +
        'If your file lives in a sandbox the server cannot read, use the inline `attachments` ' +
        'form instead — the path-based form will fail with attachment_validation_failed.'
      ),
      attachmentContentTypes: z.array(z.string()).optional().describe(
        'Parallel array to attachmentPaths overriding the detected Content-Type. ' +
        'Use "" or omit an entry to keep the detected value.'
      ),
      attachmentFilenames: z.array(z.string()).optional().describe(
        'Parallel array to attachmentPaths overriding the basename used as filename. ' +
        'Use "" or omit an entry to keep the basename.'
      ),
      stagedAttachmentIds: z.array(z.string()).optional().describe(
        'STAGED FORM (for large files or streaming uploads). Array of stagingIds returned from ' +
        'imap_attachment_stage_finalize. Use this only when the file exceeds the inline size ' +
        'ceiling (~10 MB) and is not on the server host. For small files in a Workspace/sandbox, ' +
        'prefer the inline `attachments` form — it avoids the multi-call staging dance.'
      ),
      appendToSent: z.boolean().optional().default(true).describe(
        'Append the sent message to the IMAP Sent folder after a successful SMTP send. Default true.'
      ),
      sentFolderOverride: z.string().optional().describe(
        'Force a specific Sent folder name, bypassing auto-detection.'
      ),
      forceAppendToSent: z.boolean().optional().default(false).describe(
        'Append even on accounts where auto-detection would skip (e.g. Gmail). Default false.'
      ),
      isReply: z.boolean().optional().default(false).describe(
        'Set the \\Answered flag on the Sent copy when true.'
      ),
    }
  }, withErrorHandling(async ({
    accountId, to, subject, text, html, cc, bcc, replyTo, attachments,
    attachmentPaths, attachmentContentTypes, attachmentFilenames,
    stagedAttachmentIds,
    appendToSent, sentFolderOverride, forceAppendToSent, isReply,
  }) => {
    const dbAccount = db.getDecryptedAccount(accountId);
    if (!dbAccount) {
      throw new AccountNotFoundError(accountId);
    }

    const account = toImapAccount(dbAccount);

    // ---- shared attachment policy (applies to inline, path-based, staged) ----
    const {
      validateAttachmentPaths, resolveAllowedDirs, formatValidationErrors,
      sanitizeFilename, isDotfileBasename,
    } = await import('../services/attachment-validator.js');

    const denyDotfiles = (process.env.IMAP_MCP_ALLOW_DOTFILES ?? '').toLowerCase() !== 'true';
    const maxBytes = Number(process.env.IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES ?? 20 * 1024 * 1024);
    const maxTotalBytes = Number(process.env.IMAP_MCP_MAX_TOTAL_ATTACHMENT_SIZE_BYTES ?? 20 * 1024 * 1024);
    let runningTotalBytes = 0;

    // Hoist user + allow-list resolution so both the path-based block AND
    // the inline `attachments[].path` validation (#147) share one source of
    // truth. Computed once per call regardless of which forms the caller
    // uses; cheap (single SELECT) and avoids drift between the two paths.
    const callerUserId = (() => {
      try {
        const u = db.getUserByUsername(process.env.MCP_USER_ID || 'default');
        return u?.user_id ?? null;
      } catch { return null; }
    })();
    const globalAllowedDirs = (process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const callerAllowedDirs = callerUserId
      ? resolveAllowedDirs(db, callerUserId, globalAllowedDirs)
      : globalAllowedDirs;
    const validatorConfig = {
      globalAllowedDirs,
      maxSizeBytes: maxBytes,
      maxTotalSizeBytes: maxTotalBytes,
      denyDotfiles,
    };

    // ---- WP1: resolve and validate path-based attachments ----
    const validatedPathAttachments: Array<{ filename: string; path: string; contentType: string }> = [];
    if (attachmentPaths && attachmentPaths.length > 0) {
      const inputs = attachmentPaths.map((p, i) => ({
        path: p,
        contentType: attachmentContentTypes?.[i] || undefined,
        filename: attachmentFilenames?.[i] || undefined,
      }));

      const result = await validateAttachmentPaths(inputs, validatorConfig, callerAllowedDirs);

      if (result.errors.length > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              result: 'attachment_validation_failed',
              errors: formatValidationErrors(result.errors),
              errorDetails: result.errors,
            }, null, 2)
          }]
        };
      }

      for (const a of result.attachments) {
        validatedPathAttachments.push({
          filename: a.filename,
          path: a.realPath,
          contentType: a.contentType,
        });
        runningTotalBytes += a.sizeBytes;
      }
    }

    // ---- Inline attachments: sanitize, dotfile-reject, size cap ----
    //
    // Three input shapes supported on each entry:
    //   1. { filename, content (base64) }            - inline bytes
    //   2. { filename, path }                        - host-resident file
    //   3. { filename, content, path }               - both; content wins,
    //                                                  path is ignored
    //
    // Shape 2 (the inline `path` field) was historically forwarded straight
    // to nodemailer, bypassing the WP1 (#100) allow-list and v2.17.9 dotfile
    // / size / basename rules. v2.17.11 (#147) closes that bypass: any inline
    // entry with `path` set goes through validateAttachmentPaths with the
    // same policies that gate `attachmentPaths`. Result is byte-for-byte
    // equivalent to using `attachmentPaths` directly; the inline `path` form
    // remains for backward compat and will be removed in v3.0.
    const sanitizedInlineAttachments: Array<{ filename: string; content?: Buffer; path?: string; contentType?: string }> = [];
    if (attachments && attachments.length > 0) {
      const inlineErrors: Array<{ kind: string; detail: string }> = [];
      for (const att of attachments) {
        // Bytes-shape branch (`content` set; `path` ignored if also present).
        if (att.content) {
          const cleanName = sanitizeFilename(att.filename ?? '');
          if (cleanName.length === 0) {
            inlineErrors.push({ kind: 'invalid-filename', detail: `Inline attachment has no usable filename basename: ${JSON.stringify(att.filename)}` });
            continue;
          }
          if (denyDotfiles && isDotfileBasename(cleanName)) {
            inlineErrors.push({ kind: 'dotfile-or-dotdir-rejected', detail: `Inline attachment filename '${cleanName}' is a dotfile and is denied by default. Set IMAP_MCP_ALLOW_DOTFILES=true to opt back in.` });
            continue;
          }

          let contentBuf: Buffer;
          try {
            contentBuf = Buffer.from(att.content, 'base64');
          } catch {
            inlineErrors.push({ kind: 'invalid-base64', detail: `Inline attachment '${cleanName}': content is not valid base64.` });
            continue;
          }
          if (contentBuf.length > maxBytes) {
            inlineErrors.push({ kind: 'size-exceeds-per-attachment', detail: `Inline attachment '${cleanName}' is ${humanBytes(contentBuf.length)}, exceeds per-attachment cap of ${humanBytes(maxBytes)} (override IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES).` });
            continue;
          }
          if (runningTotalBytes + contentBuf.length > maxTotalBytes) {
            inlineErrors.push({ kind: 'aggregate-size-exceeds', detail: `Inline attachment '${cleanName}' would push aggregate size to ${humanBytes(runningTotalBytes + contentBuf.length)}, exceeds total cap of ${humanBytes(maxTotalBytes)} (override IMAP_MCP_MAX_TOTAL_ATTACHMENT_SIZE_BYTES, or move large files to imap_attachment_stage_*).` });
            continue;
          }
          runningTotalBytes += contentBuf.length;

          sanitizedInlineAttachments.push({
            filename: cleanName,
            content: contentBuf,
            contentType: att.contentType,
          });
          continue;
        }

        // Path-shape branch (`path` set, `content` not). Closes #147 bypass:
        // route through the same validator that gates `attachmentPaths`.
        if (att.path) {
          const result = await validateAttachmentPaths(
            [{ path: att.path, contentType: att.contentType, filename: att.filename }],
            validatorConfig,
            callerAllowedDirs
          );
          if (result.errors.length > 0) {
            for (const e of result.errors) {
              inlineErrors.push({
                kind: e.kind,
                detail: formatValidationErrors([e])[0],
              });
            }
            continue;
          }
          for (const a of result.attachments) {
            if (runningTotalBytes + a.sizeBytes > maxTotalBytes) {
              inlineErrors.push({ kind: 'aggregate-size-exceeds', detail: `Inline path attachment '${a.filename}' would push aggregate size to ${humanBytes(runningTotalBytes + a.sizeBytes)}, exceeds total cap of ${humanBytes(maxTotalBytes)} (override IMAP_MCP_MAX_TOTAL_ATTACHMENT_SIZE_BYTES).` });
              continue;
            }
            runningTotalBytes += a.sizeBytes;
            sanitizedInlineAttachments.push({
              filename: a.filename,
              path: a.realPath,
              contentType: a.contentType,
            });
          }
          continue;
        }

        // Neither `content` nor `path` set — nothing to attach.
        inlineErrors.push({
          kind: 'empty-attachment',
          detail: `Inline attachment '${att.filename ?? '<unnamed>'}' has neither 'content' (base64) nor 'path' set.`,
        });
      }
      if (inlineErrors.length > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              result: 'attachment_validation_failed',
              errors: inlineErrors.map(e => e.detail),
              errorDetails: inlineErrors,
            }, null, 2)
          }]
        };
      }
    }

    // ---- WP2: resolve staged attachments ----
    const stagedAttachments: Array<{ filename: string; path: string; contentType: string; stagingId: string }> = [];
    if (stagedAttachmentIds && stagedAttachmentIds.length > 0) {
      if (!staging) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              result: 'staged_attachments_unavailable',
              error: 'Attachment staging service is not available on this server.',
            }, null, 2)
          }]
        };
      }
      const userId = (() => {
        try {
          const u = db.getUserByUsername(process.env.MCP_USER_ID || 'default');
          return u?.user_id ?? null;
        } catch { return null; }
      })();
      if (!userId) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              result: 'staged_attachments_unauthorized',
              error: 'Unable to resolve current user from MCP_USER_ID.',
            }, null, 2)
          }]
        };
      }
      const missing: string[] = [];
      const stagedErrors: Array<{ kind: string; detail: string }> = [];
      for (const sid of stagedAttachmentIds) {
        const f = staging.getFinalized(userId, sid);
        if (!f) {
          missing.push(sid);
          continue;
        }
        const cleanName = sanitizeFilename(f.filename ?? '');
        if (cleanName.length === 0) {
          stagedErrors.push({ kind: 'invalid-filename', detail: `Staged attachment ${sid}: stored filename has no usable basename.` });
          continue;
        }
        if (denyDotfiles && isDotfileBasename(cleanName)) {
          stagedErrors.push({ kind: 'dotfile-or-dotdir-rejected', detail: `Staged attachment ${sid}: filename '${cleanName}' is a dotfile and is denied by default. Set IMAP_MCP_ALLOW_DOTFILES=true to opt back in.` });
          continue;
        }
        const stagedSize = f.size;
        if (stagedSize > maxBytes) {
          stagedErrors.push({ kind: 'size-exceeds-per-attachment', detail: `Staged attachment '${cleanName}' is ${humanBytes(stagedSize)}, exceeds per-attachment cap of ${humanBytes(maxBytes)} (override IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES).` });
          continue;
        }
        if (runningTotalBytes + stagedSize > maxTotalBytes) {
          stagedErrors.push({ kind: 'aggregate-size-exceeds', detail: `Staged attachment '${cleanName}' would push aggregate size to ${humanBytes(runningTotalBytes + stagedSize)}, exceeds total cap of ${humanBytes(maxTotalBytes)} (override IMAP_MCP_MAX_TOTAL_ATTACHMENT_SIZE_BYTES).` });
          continue;
        }
        runningTotalBytes += stagedSize;
        stagedAttachments.push({
          filename: cleanName,
          path: f.assembledPath,
          contentType: f.contentType,
          stagingId: sid,
        });
      }
      if (stagedErrors.length > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              result: 'attachment_validation_failed',
              errors: stagedErrors.map(e => e.detail),
              errorDetails: stagedErrors,
            }, null, 2)
          }]
        };
      }
      if (missing.length > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              result: 'staged_attachments_not_found',
              missingStagingIds: missing,
              hint: 'Either the stagingId is invalid, expired, owned by another user, not finalized, or already consumed.',
            }, null, 2)
          }]
        };
      }
    }

    const emailComposer = {
      from: account.user,
      to, subject, text, html, cc, bcc, replyTo,
      attachments: [
        ...sanitizedInlineAttachments,
        ...validatedPathAttachments,
        ...stagedAttachments.map(s => ({
          filename: s.filename,
          path: s.path,
          contentType: s.contentType,
        })),
      ],
    };

    // ---- 1. SMTP send ----
    let outcome;
    try {
      outcome = await smtpService.sendEmailWithCopy(accountId, account, emailComposer);
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            result: 'send_failed',
            error: error?.message ?? 'Unknown SMTP error',
            classified: error?.classified,
            retriesAttempted: error?.retriesAttempted,
          }, null, 2)
        }]
      };
    }

    // ---- 1b. consume staged attachments now that the send succeeded ----
    if (staging && stagedAttachments.length > 0) {
      for (const s of stagedAttachments) {
        try { await staging.consume(s.stagingId); } catch {
          // Best-effort cleanup; the GC sweep will catch lingering files later.
        }
      }
    }

    const baseResult = {
      success: true,
      messageId: outcome.messageId,
      sentAt: outcome.sentAt.toISOString(),
    };

    // ---- 2. Decide whether to APPEND ----
    if (!appendToSent || !sentFolder) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...baseResult,
            result: 'sent_not_archived',
            archiveSkipped: !sentFolder ? 'sent-folder-service-unavailable' : 'appendToSent=false',
          }, null, 2)
        }]
      };
    }

    // ---- 3. Resolve Sent folder ----
    let resolved;
    try {
      resolved = await sentFolder.resolveSentFolder(accountId, {
        override: sentFolderOverride,
        autoCreate: false,
      });
    } catch (e: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...baseResult,
            result: 'sent_not_archived',
            archiveSkipped: 'resolution-failed',
            archiveError: e?.message,
          }, null, 2)
        }]
      };
    }

    // Gmail server-copies sent messages — APPENDing produces a duplicate.
    if (resolved.gmailAutoSkip && !forceAppendToSent && !sentFolderOverride) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...baseResult,
            result: 'sent_and_archived',
            archive: { method: 'gmail-server-copy', folder: resolved.folderName ?? '[Gmail]/Sent Mail' },
          }, null, 2)
        }]
      };
    }

    if (!resolved.folderName) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...baseResult,
            result: 'sent_not_archived',
            archiveSkipped: 'no-sent-folder-found',
            resolutionMethod: resolved.method,
          }, null, 2)
        }]
      };
    }

    // ---- 4. APPEND to Sent ----
    const appendFlags = ['\\Seen'];
    if (isReply) appendFlags.push('\\Answered');

    try {
      const appendResult = await imapService.appendMessage(
        accountId,
        resolved.folderName,
        outcome.rawMessage,
        { flags: appendFlags, internalDate: outcome.sentAt }
      );
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...baseResult,
            result: 'sent_and_archived',
            archive: {
              folder: resolved.folderName,
              uid: appendResult.uid,
              method: resolved.method,
              cacheHit: resolved.cacheHit,
            },
          }, null, 2)
        }]
      };
    } catch (e: any) {
      // SMTP succeeded; APPEND failed. Queue for retry if available.
      let queued = false;
      if (appendRetry) {
        try {
          await appendRetry.enqueue({
            accountId,
            targetFolder: resolved.folderName,
            messageBytes: outcome.rawMessage,
            flags: appendFlags,
            internalDate: outcome.sentAt,
          });
          queued = true;
        } catch {
          // Best-effort; surface in response either way.
        }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...baseResult,
            result: 'sent_not_archived',
            archive: {
              folder: resolved.folderName,
              method: resolved.method,
              error: e?.message ?? 'APPEND failed',
              queuedForRetry: queued,
            },
          }, null, 2)
        }]
      };
    }
  }));



  // ---- WP4 diagnostic tools ----
  if (sentFolder) {
    server.registerTool('imap_test_sent_folder', {
      description:
        'Diagnose Sent folder resolution for an account. Returns the resolved folder name, ' +
        'the resolution method (cache, special_use, preset, fallback, auto_created, failed), ' +
        'whether the cache was hit, and whether the account would skip APPEND under default ' +
        'settings (Gmail server-copy behavior).',
      inputSchema: {
        accountId: z.string().describe('Account ID'),
        invalidateCache: z.boolean().optional().default(false).describe(
          'Force a fresh resolution by clearing the cache entry first.'
        ),
      }
    }, withErrorHandling(async ({ accountId, invalidateCache }) => {
      if (invalidateCache) {
        sentFolder.invalidateCache(accountId);
      }
      const resolved = await sentFolder.resolveSentFolder(accountId);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            accountId,
            resolvedFolder: resolved.folderName,
            resolutionMethod: resolved.method,
            cacheHit: resolved.cacheHit,
            gmailAutoSkip: resolved.gmailAutoSkip,
          }, null, 2)
        }]
      };
    }));
  }

  if (appendRetry) {
    server.registerTool('imap_list_unarchived_sends', {
      description:
        'List queued Sent-folder APPEND operations that failed after a successful SMTP send. ' +
        'These are retried automatically every 5 minutes for 24 hours. Use this tool to surface ' +
        'them to the user when the IMAP server has been unavailable.',
      inputSchema: {
        accountId: z.string().optional().describe('Filter to one account ID'),
        limit: z.number().optional().default(50).describe('Max entries to return (default 50)'),
      }
    }, withErrorHandling(async ({ accountId, limit }) => {
      const items = appendRetry.list({ accountId, limit });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: items.length,
            items: items.map((i) => ({
              id: i.id,
              accountId: i.accountId,
              targetFolder: i.targetFolder,
              flags: i.flags,
              internalDate: i.internalDate.toISOString(),
              createdAt: i.createdAt.toISOString(),
              lastAttemptAt: i.lastAttemptAt?.toISOString() ?? null,
              attemptCount: i.attemptCount,
              lastError: i.lastError,
              expiresAt: i.expiresAt.toISOString(),
            })),
          }, null, 2)
        }]
      };
    }));
  }

  // ---- WP2 attachment staging tools ----
  if (staging) {
    server.registerTool('imap_attachment_stage_init', {
      description:
        'Begin a chunked attachment upload. Use only when the file exceeds the ~10 MB inline ' +
        'ceiling of imap_send_email\'s `attachments` form, or when streaming from a source that ' +
        "cannot fit a single MCP request. For small files in a sandbox (Claude Desktop Workspace, " +
        'Claude.ai /mnt/user-data/outputs/), prefer the inline `attachments` form on imap_send_email ' +
        '— it is a single tool call, no chunking, no allow-list. ' +
        'Returns a stagingId, server-recommended chunkSizeBytes (default 256 KiB), and an expiresAt ' +
        'timestamp (default 1 hour). Subsequent chunks are sent via imap_attachment_stage_append. ' +
        "Per-user disk quota is enforced — the call fails if the session's expectedSize would " +
        'exceed it.',
      inputSchema: {
        filename: z.string().describe('Original filename (used as the attachment basename).'),
        expectedSize: z.number().int().nonnegative().describe('Total size the client intends to upload, in bytes.'),
        contentType: z.string().optional().describe('MIME type. Defaults to application/octet-stream.'),
        ttlSeconds: z.number().int().positive().optional().describe('Override the default 1-hour TTL.'),
      }
    }, withErrorHandling(async ({ filename, expectedSize, contentType, ttlSeconds }) => {
      const userId = (() => {
        try { return db.getUserByUsername(process.env.MCP_USER_ID || 'default')?.user_id ?? null; }
        catch { return null; }
      })();
      if (!userId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false, error: 'Unable to resolve user from MCP_USER_ID',
          }, null, 2) }]
        };
      }
      const result = await staging.init({
        userId, filename, expectedSize, contentType,
        ttlMs: ttlSeconds ? ttlSeconds * 1000 : undefined,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }]
      };
    }));

    server.registerTool('imap_attachment_stage_append', {
      description:
        'Append one chunk to a staging session. Chunks may arrive out-of-order; duplicate chunkIndex ' +
        'is idempotent. Set isFinal=true on the last chunk to auto-finalize and skip an explicit ' +
        'imap_attachment_stage_finalize call.',
      inputSchema: {
        stagingId: z.string().describe('From imap_attachment_stage_init'),
        chunkIndex: z.number().int().nonnegative().describe('0-indexed position in the byte stream.'),
        chunkData: z.string().describe('Base64-encoded chunk bytes.'),
        isFinal: z.boolean().optional().default(false).describe('If true, finalize after this chunk.'),
      }
    }, withErrorHandling(async ({ stagingId, chunkIndex, chunkData, isFinal }) => {
      const result = await staging.append({ stagingId, chunkIndex, chunkData, isFinal });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }]
      };
    }));

    server.registerTool('imap_attachment_stage_finalize', {
      description:
        'Concatenate the uploaded chunks in order, compute SHA-256, mark the session ready for use ' +
        'in imap_send_email via stagedAttachmentIds. Required only if no append call set isFinal=true.',
      inputSchema: {
        stagingId: z.string().describe('From imap_attachment_stage_init'),
      }
    }, withErrorHandling(async ({ stagingId }) => {
      const result = await staging.finalize({ stagingId });
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }]
      };
    }));

    server.registerTool('imap_attachment_stage_cancel', {
      description: 'Discard a staging session and reclaim its disk space.',
      inputSchema: {
        stagingId: z.string().describe('From imap_attachment_stage_init'),
      }
    }, withErrorHandling(async ({ stagingId }) => {
      await staging.cancel(stagingId);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, stagingId }, null, 2) }]
      };
    }));

    server.registerTool('imap_list_staged_attachments', {
      description:
        'List staging sessions for the current user (or all users if no userId is provided and the ' +
        'caller is admin context). Useful for debugging and quota checks.',
      inputSchema: {
        limit: z.number().int().positive().optional().default(50),
      }
    }, withErrorHandling(async ({ limit }) => {
      const userId = (() => {
        try { return db.getUserByUsername(process.env.MCP_USER_ID || 'default')?.user_id ?? null; }
        catch { return null; }
      })();
      if (!userId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            success: false, error: 'Unable to resolve user',
          }, null, 2) }]
        };
      }
      const items = staging.list({ userId, limit });
      const bytesInUse = staging.userBytesInUse(userId);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: items.length,
            bytesInUse,
            items: items.map((r) => ({
              stagingId: r.staging_id,
              filename: r.filename,
              contentType: r.content_type,
              expectedSize: r.expected_size,
              currentSize: r.current_size,
              chunksReceived: r.chunks_received,
              finalized: !!r.finalized,
              consumedAt: r.consumed_at ? new Date(r.consumed_at).toISOString() : null,
              expiresAt: new Date(r.expires_at).toISOString(),
              createdAt: new Date(r.created_at).toISOString(),
              sha256: r.sha256,
            })),
          }, null, 2)
        }]
      };
    }));
  }

  // ---- WP3 diagnostic + metrics tools ----
  server.registerTool('imap_test_smtp', {
    description:
      'Probe SMTP connectivity for an account without sending. Returns TLS version & cipher, ' +
      'certificate validity & expiry, server greeting, EHLO capabilities, AUTH methods, RTT, ' +
      'auth pass/fail, and provider-aware guidance for known auth-failure patterns (Gmail app ' +
      "passwords, Outlook app passwords, etc.). Use 'verbose' to include the raw SMTP transcript.",
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      verbose: z.boolean().optional().default(false).describe('Include the raw SMTP transcript in the response.'),
      testAuth: z.boolean().optional().default(true).describe('Attempt AUTH after connect. Default true.'),
    }
  }, withErrorHandling(async ({ accountId, verbose, testAuth }) => {
    const dbAccount = db.getDecryptedAccount(accountId);
    if (!dbAccount) throw new AccountNotFoundError(accountId);
    const account = {
      id: dbAccount.account_id, name: dbAccount.name, host: dbAccount.host, port: dbAccount.port,
      user: dbAccount.username, password: dbAccount.password, tls: dbAccount.tls,
      smtp: dbAccount.smtp_host ? {
        host: dbAccount.smtp_host, port: dbAccount.smtp_port!,
        secure: dbAccount.smtp_secure || false,
        user: dbAccount.smtp_username, password: dbAccount.smtp_password,
      } : undefined,
    };
    const result = await smtpService.testSmtp(account, { verbose, testAuth });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }));

  server.registerTool('imap_get_smtp_metrics', {
    description:
      'Get per-account SMTP metrics: send total, success/failure counts, retry counts (split ' +
      'by error category), last-send duration and timestamp, last error info. Pass no accountId ' +
      'to retrieve metrics for all accounts that have sent.',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID (omit for all accounts)'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    const metrics = smtpService.getSmtpMetrics(accountId);
    const pool = smtpService.getPoolStats();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ accounts: metrics, pool }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_reset_smtp_metrics', {
    description: 'Reset SMTP metrics for an account (or all accounts if omitted).',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID (omit to reset all)'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    smtpService.resetSmtpMetrics(accountId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ success: true, scope: accountId ?? 'all' }, null, 2)
      }]
    };
  }));

  // Reply to email tool
  server.registerTool('imap_reply_to_email', {
    description: 'Reply to an existing email',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder containing the original email'),
      uid: z.number().describe('UID of the email to reply to'),
      text: z.string().optional().describe('Plain text reply content'),
      html: z.string().optional().describe('HTML reply content'),
      replyAll: z.boolean().default(false).describe('Reply to all recipients'),
      attachments: z.array(z.object({
        filename: z.string().describe('Attachment filename'),
        content: z.string().optional().describe('Base64 encoded content'),
        path: z.string().optional().describe('File path to attach'),
        contentType: z.string().optional().describe('MIME type'),
      })).optional().describe('Email attachments'),
    }
  }, withErrorHandling(async ({ accountId, folder, uid, text, html, replyAll, attachments }) => {
    const dbAccount = db.getDecryptedAccount(accountId);
    if (!dbAccount) {
      throw new AccountNotFoundError(accountId);
    }

    const account = toImapAccount(dbAccount);

    // Get original email
    const originalEmail = await imapService.getEmailContent(accountId, folder, uid);

    // Prepare reply
    const recipients = [originalEmail.from];
    if (replyAll) {
      recipients.push(...originalEmail.to.filter(addr => addr !== account.user));
    }

    const emailComposer = {
      from: account.user,
      to: recipients,
      subject: originalEmail.subject.startsWith('Re: ') ? originalEmail.subject : `Re: ${originalEmail.subject}`,
      text,
      html,
      inReplyTo: originalEmail.messageId,
      references: originalEmail.messageId,
      attachments: attachments?.map(att => ({
        filename: att.filename,
        content: att.content ? Buffer.from(att.content, 'base64') : undefined,
        path: att.path,
        contentType: att.contentType,
      })),
    };

    const messageId = await smtpService.sendEmail(accountId, account, emailComposer);
    
    return jsonResult({ success: true, messageId, message: 'Reply sent successfully' });
  }));

  // Forward email tool
  server.registerTool('imap_forward_email', {
    description: 'Forward an existing email',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder containing the original email'),
      uid: z.number().describe('UID of the email to forward'),
      to: z.union([z.string(), z.array(z.string())]).describe('Forward to email address(es)'),
      text: z.string().optional().describe('Additional text to include'),
      includeAttachments: z.boolean().default(true).describe('Include original attachments'),
    }
  }, withErrorHandling(async ({ accountId, folder, uid, to, text, includeAttachments }) => {
    const dbAccount = db.getDecryptedAccount(accountId);
    if (!dbAccount) {
      throw new AccountNotFoundError(accountId);
    }

    const account = toImapAccount(dbAccount);

    // Get original email
    const originalEmail = await imapService.getEmailContent(accountId, folder, uid);

    // Prepare forwarded content
    const forwardHeader = `\n\n---------- Forwarded message ----------\nFrom: ${originalEmail.from}\nDate: ${originalEmail.date.toLocaleString()}\nSubject: ${originalEmail.subject}\nTo: ${originalEmail.to.join(', ')}\n\n`;

    const emailComposer = {
      from: account.user,
      to,
      subject: originalEmail.subject.startsWith('Fwd: ') ? originalEmail.subject : `Fwd: ${originalEmail.subject}`,
      text: (text || '') + forwardHeader + (originalEmail.textContent || ''),
      html: originalEmail.htmlContent,
      references: originalEmail.messageId,
    };

    const messageId = await smtpService.sendEmail(accountId, account, emailComposer);

    return jsonResult({ success: true, messageId, message: 'Email forwarded successfully' });
  }));

  // Level 2: Bulk get emails tool
  // AUTO-CHUNKING: Automatically uses chunked processing for >50 UIDs
  server.registerTool('imap_bulk_get_emails', {
    description:
      'Bulk fetch multiple emails at once. Automatically uses chunked processing for >50 UIDs. ' +
      "Pass responseMode='handle' or 'file' to avoid token-budget truncation on large sets.",
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs to fetch'),
      fields: z.enum(['headers', 'full', 'body']).default('headers').describe('Fields to fetch: headers (metadata only), body (with text), or full (everything)'),
      responseMode: ResponseModeSchema,
      storageType: StorageTypeSchema,
    }
  }, withErrorHandling(async ({ accountId, folder, uids, fields, responseMode, storageType }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to fetch',
            emails: [],
            count: 0,
          }, null, 2)
        }]
      };
    }

    const AUTO_CHUNK_THRESHOLD = 50;
    let emails;

    // Automatically use chunked processing for large operations
    if (uids.length > AUTO_CHUNK_THRESHOLD) {
      console.error(`[MCP] Auto-chunking fetch: ${uids.length} UIDs > ${AUTO_CHUNK_THRESHOLD} threshold`);
      emails = await imapService.bulkGetEmailsChunked(accountId, folder, uids, fields, {
        chunkSize: 100,
        onProgress: (processed, total) => {
          console.error(`[MCP] Fetch progress: ${processed}/${total} processed`);
        }
      });
    } else {
      emails = await imapService.bulkGetEmails(accountId, folder, uids, fields);
    }

    const userId = results ? resolveUserId(db) : null;
    if (results && userId && shouldUseHandle(responseMode, emails.length)) {
      // Handle mode: store the full rows (no per-body truncation) and return a handle.
      const rows = await summarizeEmails(emails, { fields }, workerPool);
      return maybeStoreAsHandle({
        userId,
        accountId,
        toolName: 'imap_bulk_get_emails',
        folder,
        params: { accountId, folder, uids, fields },
        rows,
        responseMode,
        storageType,
        results,
        extra: {
          totalRequested: uids.length,
          chunked: uids.length > AUTO_CHUNK_THRESHOLD,
        },
      });
    }

    // Inline path: truncate bodies for token budget (backward compatible).
    const limitedEmails = emails.map((email: any) => ({
      ...email,
      textContent: email.textContent?.substring(0, 5000),
      htmlContent: email.htmlContent?.substring(0, 5000),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          count: emails.length,
          totalRequested: uids.length,
          emails: limitedEmails,
          chunked: uids.length > AUTO_CHUNK_THRESHOLD,
        }, null, 2)
      }]
    };
  }));

  // Level 2: Bulk mark emails tool (Issue #54: RFC 9051 extended flags)
  // AUTO-CHUNKING: Automatically uses chunked processing for >50 UIDs
  server.registerTool('imap_bulk_mark_emails', {
    description: 'Bulk mark multiple emails with standard IMAP flags. Automatically uses chunked processing for >50 UIDs to prevent timeouts.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs to mark'),
      operation: z.enum(['read', 'unread', 'flagged', 'unflagged', 'answered', 'unanswered', 'draft', 'not-draft', 'deleted', 'undeleted']).describe('Mark operation to perform'),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, operation }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to mark',
            processedCount: 0,
          }, null, 2)
        }]
      };
    }

    const AUTO_CHUNK_THRESHOLD = 50;

    // Automatically use chunked processing for large operations
    if (uids.length > AUTO_CHUNK_THRESHOLD) {
      console.error(`[MCP] Auto-chunking: ${uids.length} UIDs > ${AUTO_CHUNK_THRESHOLD} threshold`);

      const result = await imapService.bulkMarkEmailsChunked(accountId, folder, uids, operation, {
        chunkSize: 100,
        onProgress: (processed, total, failed) => {
          console.error(`[MCP] Progress: ${processed}/${total} processed, ${failed} failed`);
        }
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: result.failed === 0,
            message: `Marked ${result.processed} email(s) as ${operation} (${result.failed} failed, auto-chunked)`,
            processed: result.processed,
            failed: result.failed,
            chunked: true,
            errors: result.errors.length > 0 ? result.errors : undefined,
          }, null, 2)
        }]
      };
    }

    // Use standard bulk operation for small batches
    await imapService.bulkMarkEmails(accountId, folder, uids, operation);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Successfully marked ${uids.length} email(s) as ${operation}`,
        }, null, 2)
      }]
    };
  }));

  // Issue #4: Copy email tool
  server.registerTool('imap_copy_email', {
    description: 'Copy an email to another folder',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      sourceFolder: z.string().default('INBOX').describe('Source folder name'),
      uid: z.number().describe('Email UID to copy'),
      targetFolder: z.string().describe('Target folder name'),
    }
  }, withErrorHandling(async ({ accountId, sourceFolder, uid, targetFolder }) => {
    await imapService.copyEmail(accountId, sourceFolder, uid, targetFolder);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Email ${uid} copied from ${sourceFolder} to ${targetFolder}`,
        }, null, 2)
      }]
    };
  }));

  // Issue #4: Bulk copy emails tool
  server.registerTool('imap_bulk_copy_emails', {
    description: 'Bulk copy multiple emails to another folder',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      sourceFolder: z.string().default('INBOX').describe('Source folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs to copy'),
      targetFolder: z.string().describe('Target folder name'),
    }
  }, withErrorHandling(async ({ accountId, sourceFolder, uids, targetFolder }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to copy',
            processedCount: 0,
          }, null, 2)
        }]
      };
    }

    await imapService.bulkCopyEmails(accountId, sourceFolder, uids, targetFolder);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Successfully copied ${uids.length} email(s) from ${sourceFolder} to ${targetFolder}`,
        }, null, 2)
      }]
    };
  }));

  // Issue #4: Move email tool
  server.registerTool('imap_move_email', {
    description: 'Move an email to another folder (copy + delete)',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      sourceFolder: z.string().default('INBOX').describe('Source folder name'),
      uid: z.number().describe('Email UID to move'),
      targetFolder: z.string().describe('Target folder name'),
    }
  }, withErrorHandling(async ({ accountId, sourceFolder, uid, targetFolder }) => {
    await imapService.moveEmail(accountId, sourceFolder, uid, targetFolder);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Email ${uid} moved from ${sourceFolder} to ${targetFolder}`,
        }, null, 2)
      }]
    };
  }));

  // Issue #4: Bulk move emails tool
  server.registerTool('imap_bulk_move_emails', {
    description: 'Bulk move multiple emails to another folder (copy + delete)',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      sourceFolder: z.string().default('INBOX').describe('Source folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs to move'),
      targetFolder: z.string().describe('Target folder name'),
    }
  }, withErrorHandling(async ({ accountId, sourceFolder, uids, targetFolder }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to move',
            processedCount: 0,
          }, null, 2)
        }]
      };
    }

    await imapService.bulkMoveEmails(accountId, sourceFolder, uids, targetFolder);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Successfully moved ${uids.length} email(s) from ${sourceFolder} to ${targetFolder}`,
        }, null, 2)
      }]
    };
  }));

  // Level 3: Get connection metrics
  server.registerTool('imap_get_metrics', {
    description: 'Get connection metrics and health information for an account',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    const metrics = await imapService.getMetrics(accountId);

    if (!metrics) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            message: `No metrics found for account ${accountId}`,
          }, null, 2)
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          accountId,
          metrics: {
            ...metrics,
            lastOperationTime: metrics.lastOperationTime?.toISOString(),
          },
          usage:
            '`failedOperations > 0` with the breaker still CLOSED indicates errors that did not ' +
            'trip the breaker (commonly idle disconnects from Hostinger / Yahoo / similar — ' +
            'fixed in v2.16.0 #116 by removing client.error from the breaker trip path). For the ' +
            'breaker state itself call imap_get_circuit_breaker. To clear counters call ' +
            'imap_reset_metrics. For per-operation latency / success-rate breakdown call ' +
            'imap_get_operation_metrics with this same accountId.',
        }, null, 2)
      }]
    };
  }));

  // Level 3: Get operation metrics
  server.registerTool('imap_get_operation_metrics', {
    description: 'Get detailed metrics for IMAP operations',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      operationName: z.string().optional().describe('Specific operation name (optional, returns all if not specified)'),
    }
  }, withErrorHandling(async ({ accountId, operationName }) => {
    const metrics = imapService.getOperationMetrics(accountId, operationName);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          operations: metrics.map((m: any) => ({
            ...m,
            lastExecuted: m.lastExecuted?.toISOString(),
          })),
          usage:
            'Per-operation counters across the lifetime of the connection. Pass `operationName` ' +
            'on the input to filter to a single operation (e.g., "fetch", "search", "store"). ' +
            'Compare to imap_get_metrics for per-account aggregate; compare to ' +
            'imap_get_circuit_breaker for the protection state derived from these counters.',
        }, null, 2)
      }]
    };
  }));

  // Circuit-breaker diagnostic + manual reset
  server.registerTool('imap_get_circuit_breaker', {
    description:
      'Inspect the per-account circuit breaker state (CLOSED / OPEN / HALF_OPEN), ' +
      'failure count, last failure reason, and configured thresholds/timeout. Use this to ' +
      'understand why operations are being blocked when imap_get_metrics shows zero failures.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    const state = imapService.getCircuitBreakerState(accountId);
    if (!state) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: `No circuit breaker state for account ${accountId}`,
            usage:
              'No state yet — the circuit breaker is created lazily on the first connection. ' +
              'Call imap_connect first, then re-invoke this tool to inspect state.',
          }, null, 2)
        }]
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...state,
          usage:
            'CLOSED = healthy, OPEN = blocked (operations short-circuit until timeoutMs elapses), ' +
            'HALF_OPEN = trial state allowing one test call. To force a recovery, call ' +
            'imap_reset_circuit_breaker. To see the underlying counters that drove the trip, ' +
            'call imap_get_metrics. v2.16.0 (#116) removed idle-disconnect events from the ' +
            'trip path, so a CLOSED breaker with non-zero failedOperations in metrics is ' +
            'expected on Hostinger / Yahoo / similar providers.',
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_reset_circuit_breaker', {
    description:
      'Manually reset the circuit breaker for an account back to CLOSED with zero failure ' +
      "count. Use when the breaker has tripped due to transient errors and you don't want " +
      "to wait for the timeout-based HALF_OPEN transition. Returns the breaker's previous " +
      'state for diagnostics.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    const previous = imapService.resetCircuitBreaker(accountId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          previous
            ? { success: true, accountId, previous }
            : { success: false, error: `No circuit breaker state for account ${accountId}` },
          null, 2
        )
      }]
    };
  }));

  // Level 3: Reset metrics
  server.registerTool('imap_reset_metrics', {
    description: 'Reset connection metrics for an account',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
    }
  }, withErrorHandling(async ({ accountId }) => {
    imapService.resetMetrics(accountId);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Metrics reset for account ${accountId}`,
        }, null, 2)
      }]
    };
  }));

  // RFC 9051: Add keyword to emails (Issue #54)
  server.registerTool('imap_add_keyword', {
    description: 'Add a custom keyword to emails. RFC 9051 recommended keywords: $Forwarded, $MDNSent, $Junk, $NotJunk, $Phishing',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs'),
      keyword: z.string().describe('Keyword to add (e.g., $Forwarded, $Junk, or custom)'),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, keyword }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to update',
            processedCount: 0,
          }, null, 2)
        }]
      };
    }

    await imapService.bulkAddKeyword(accountId, folder, uids, keyword);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Successfully added keyword "${keyword}" to ${uids.length} email(s)`,
        }, null, 2)
      }]
    };
  }));

  // RFC 9051: Remove keyword from emails (Issue #54)
  server.registerTool('imap_remove_keyword', {
    description: 'Remove a custom keyword from emails',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs'),
      keyword: z.string().describe('Keyword to remove (e.g., $Forwarded, $Junk, or custom)'),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, keyword }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to update',
            processedCount: 0,
          }, null, 2)
        }]
      };
    }

    await imapService.bulkRemoveKeyword(accountId, folder, uids, keyword);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Successfully removed keyword "${keyword}" from ${uids.length} email(s)`,
        }, null, 2)
      }]
    };
  }));

  // RFC 9051: APPEND command - Upload a message to a mailbox (Issue #52)
  server.registerTool('imap_append_message', {
    description: 'Append a raw RFC822 message to a mailbox (useful for importing emails, saving drafts, or copying messages)',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      mailbox: z.string().default('INBOX').describe('Mailbox name to append to'),
      messageContent: z.string().describe('Raw RFC822 message content (headers + body)'),
      flags: z.array(z.string()).optional().describe('Initial flags for the message (e.g., ["\\Seen", "\\Flagged"])'),
      internalDate: z.string().optional().describe('Internal date for the message (ISO 8601 format)'),
    }
  }, withErrorHandling(async ({ accountId, mailbox, messageContent, flags, internalDate }) => {
    const options: { flags?: string[]; internalDate?: Date } = {};

    if (flags) {
      options.flags = flags;
    }

    if (internalDate) {
      options.internalDate = new Date(internalDate);
    }

    const result = await imapService.appendMessage(accountId, mailbox, messageContent, options);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Message appended to ${mailbox}`,
          uid: result.uid,
          uidValidity: result.uidValidity.toString(),
        }, null, 2)
      }]
    };
  }));

  // Chunked bulk operations for large-scale processing
  server.registerTool('imap_bulk_mark_emails_chunked', {
    description: 'Bulk mark emails with chunking for large operations (1000+ messages). Processes in chunks to avoid timeouts and circuit breaker trips. Returns progress summary.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs to mark'),
      operation: z.enum(['read', 'unread', 'flagged', 'unflagged', 'answered', 'unanswered', 'draft', 'not-draft', 'deleted', 'undeleted']).describe('Mark operation to perform'),
      chunkSize: z.number().optional().default(100).describe('Number of emails to process per chunk (default: 100)'),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, operation, chunkSize }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to mark',
            processed: 0,
            failed: 0,
          }, null, 2)
        }]
      };
    }

    const result = await imapService.bulkMarkEmailsChunked(accountId, folder, uids, operation, {
      chunkSize,
      onProgress: (processed, total, failed) => {
        console.error(`[MCP] Progress: ${processed}/${total} processed, ${failed} failed`);
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.failed === 0,
          message: `Marked ${result.processed} email(s) as ${operation} (${result.failed} failed)`,
          processed: result.processed,
          failed: result.failed,
          errors: result.errors.length > 0 ? result.errors : undefined,
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_bulk_delete_emails_chunked', {
    description: 'Bulk delete emails with chunking for large operations (1000+ messages). Processes in chunks to avoid timeouts and circuit breaker trips. Returns progress summary.',
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs to delete'),
      expunge: z.boolean().default(false).describe('Permanently expunge deleted emails (default: false, just marks as deleted)'),
      chunkSize: z.number().optional().default(100).describe('Number of emails to process per chunk (default: 100)'),
    }
  }, withErrorHandling(async ({ accountId, folder, uids, expunge, chunkSize }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to delete',
            processed: 0,
            failed: 0,
          }, null, 2)
        }]
      };
    }

    const result = await imapService.bulkDeleteEmailsChunked(accountId, folder, uids, expunge, {
      chunkSize,
      onProgress: (processed, total, failed) => {
        console.error(`[MCP] Delete progress: ${processed}/${total} processed, ${failed} failed`);
      }
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: result.failed === 0,
          message: `Deleted ${result.processed} email(s) (${result.failed} failed)`,
          processed: result.processed,
          failed: result.failed,
          expunged: expunge,
          errors: result.errors.length > 0 ? result.errors : undefined,
        }, null, 2)
      }]
    };
  }));

  server.registerTool('imap_bulk_get_emails_chunked', {
    description:
      'Bulk fetch emails with chunking for large operations (1000+ messages). ' +
      "Defaults responseMode='handle' so large fetches don't blow the token budget.",
    inputSchema: {
      accountId: z.string().describe('Account ID'),
      folder: z.string().default('INBOX').describe('Folder name'),
      uids: z.array(z.number()).describe('Array of email UIDs to fetch'),
      fields: z.enum(['headers', 'full', 'body']).default('headers').describe('Fields to fetch: headers (metadata only), body (with text), or full (everything)'),
      chunkSize: z.number().optional().default(100).describe('Number of emails to process per chunk (default: 100)'),
      responseMode: ResponseModeSchema,
      storageType: StorageTypeSchema,
    }
  }, withErrorHandling(async ({ accountId, folder, uids, fields, chunkSize, responseMode, storageType }) => {
    if (uids.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'No emails to fetch',
            emails: [],
            count: 0,
          }, null, 2)
        }]
      };
    }

    const emails = await imapService.bulkGetEmailsChunked(accountId, folder, uids, fields, {
      chunkSize,
      onProgress: (processed, total) => {
        console.error(`[MCP] Fetch progress: ${processed}/${total} processed`);
      }
    });

    // This tool is explicitly for large sets; default to handle storage when available.
    const modeOrDefault: ResponseModeOpt = responseMode ?? 'handle';
    const userId = results ? resolveUserId(db) : null;
    if (results && userId && shouldUseHandle(modeOrDefault, emails.length)) {
      const rows = await summarizeEmails(emails, { fields }, workerPool);
      return maybeStoreAsHandle({
        userId,
        accountId,
        toolName: 'imap_bulk_get_emails_chunked',
        folder,
        params: { accountId, folder, uids, fields, chunkSize },
        rows,
        responseMode: modeOrDefault,
        storageType,
        results,
        extra: { totalRequested: uids.length },
      });
    }

    const limitedEmails = emails.map((email: any) => ({
      ...email,
      textContent: email.textContent?.substring(0, 5000),
      htmlContent: email.htmlContent?.substring(0, 5000),
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          count: emails.length,
          totalRequested: uids.length,
          emails: limitedEmails,
        }, null, 2)
      }]
    };
  }));
}