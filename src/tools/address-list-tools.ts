// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// address-list-tools.ts — per-user allow/deny list management (#69/#70).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { withErrorHandling } from '../utils/error-handler.js';
import { DatabaseService } from '../services/database-service.js';
import { resolveUserOrThrow } from '../utils/user-resolver.js';
import { AddressListService, parseCsvEmails, parseVcfEmails } from '../services/address-list-service.js';

const ListTypeSchema = z.enum(['allow', 'deny']);

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

export function addressListTools(server: McpServer, db: DatabaseService): void {
  const lists = new AddressListService(db);

  server.registerTool('imap_add_list_entry', {
    description:
      'Add an entry to a per-user allow or deny list. Value may be an email address or a bare/`@`-prefixed domain ' +
      '(e.g. "a@x.com" or "x.com"). Allow entries protect a sender; deny entries flag one. Normalized + deduped.',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username)'),
      listType: ListTypeSchema.describe('allow or deny'),
      value: z.string().describe('Email address or domain'),
      note: z.string().optional().describe('Optional note'),
    },
  }, withErrorHandling(async ({ userId, listType, value, note }) => {
    const uid = resolveUserOrThrow(db, userId);
    const entry = lists.addEntry(uid, listType, value, note);
    return entry
      ? json({ success: true, added: entry })
      : json({ success: false, message: `"${value}" is not a valid email address or domain.` });
  }));

  server.registerTool('imap_remove_list_entry', {
    description: 'Remove an entry from a per-user allow or deny list (matches the normalized value).',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username)'),
      listType: ListTypeSchema,
      value: z.string().describe('Email address or domain to remove'),
    },
  }, withErrorHandling(async ({ userId, listType, value }) => {
    const uid = resolveUserOrThrow(db, userId);
    return json({ success: lists.removeEntry(uid, listType, value), value });
  }));

  server.registerTool('imap_list_entries', {
    description: 'List a user\'s allow/deny entries (optionally filtered to one list).',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username)'),
      listType: ListTypeSchema.optional().describe('Filter to allow or deny; omit for both'),
    },
  }, withErrorHandling(async ({ userId, listType }) => {
    const uid = resolveUserOrThrow(db, userId);
    const entries = lists.listEntries(uid, listType);
    return json({ count: entries.length, entries });
  }));

  server.registerTool('imap_check_address', {
    description:
      'Check a sender (a plain address, or a full From header with display name) against the user\'s allow/deny lists. Returns the verdict ' +
      '(allow / deny / null) and what matched. Email matches beat domain matches; allow beats deny at each level.',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username)'),
      from: z.string().describe('Sender address or From header'),
    },
  }, withErrorHandling(async ({ userId, from }) => {
    const uid = resolveUserOrThrow(db, userId);
    return json({ from, ...lists.check(uid, from) });
  }));

  server.registerTool('imap_import_list', {
    description:
      'Bulk-import addresses into an allow/deny list from CSV or vCard (.vcf — including Apple Contacts exports). ' +
      'Emails are extracted from the content (any CSV column; vCard EMAIL lines), normalized, and deduped.',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username)'),
      listType: ListTypeSchema,
      format: z.enum(['csv', 'vcf', 'auto']).optional().default('auto').describe('Source format (auto-detects vCard by BEGIN:VCARD)'),
      content: z.string().describe('Raw file content (CSV or vCard text)'),
      note: z.string().optional().describe('Optional note applied to all imported entries'),
    },
  }, withErrorHandling(async ({ userId, listType, format, content, note }) => {
    const uid = resolveUserOrThrow(db, userId);
    const fmt = format === 'auto' || !format ? (/BEGIN:VCARD/i.test(content) ? 'vcf' : 'csv') : format;
    const emails = fmt === 'vcf' ? parseVcfEmails(content) : parseCsvEmails(content);
    if (emails.length === 0) return json({ success: false, format: fmt, message: 'No email addresses found in the content.' });
    const res = lists.importEntries(uid, listType, emails, note);
    return json({ success: true, format: fmt, found: emails.length, ...res });
  }));

  server.registerTool('imap_clear_list', {
    description: 'Remove ALL entries from a user\'s allow or deny list. Irreversible.',
    inputSchema: {
      userId: z.string().describe('User ID (UUID or username)'),
      listType: ListTypeSchema,
    },
  }, withErrorHandling(async ({ userId, listType }) => {
    const uid = resolveUserOrThrow(db, userId);
    return json({ success: true, listType, removed: lists.clear(uid, listType) });
  }));
}
