// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Folder / mailbox MCP tools.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)
//
// Registers the folder-oriented tools: listing, status, unread counts,
// create/delete/rename, and the RFC 9051 subscription + STATUS commands.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ImapService } from '../services/imap-service.js';
import { DatabaseService } from '../services/database-service.js';
import { Folder } from '../types/index.js';
import { withErrorHandling } from '../utils/error-handler.js';
import { humanBytes } from '../utils/human-bytes.js';

/** Wrap any payload as a pretty-printed JSON text tool result. */
function jsonResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/** Shorthand for the `{ success, message }` confirmation result. */
function confirm(message: string) {
  return jsonResult({ success: true, message });
}

/** Flatten a Folder into the summary shape returned by the listing tools. */
function summarizeFolder(folder: Folder) {
  return {
    name: folder.name,
    delimiter: folder.delimiter,
    attributes: folder.attributes,
    hasChildren: Array.isArray(folder.children) && folder.children.length > 0,
  };
}

const accountId = z.string().describe('Account ID');

export function folderTools(
  server: McpServer,
  imapService: ImapService,
  db: DatabaseService
): void {
  server.registerTool('imap_list_folders', {
    description: 'List all folders/mailboxes in an IMAP account',
    inputSchema: { accountId },
  }, withErrorHandling(async ({ accountId }) => {
    const folders = await imapService.listFolders(accountId);
    return jsonResult({ folders: folders.map(summarizeFolder) });
  }));

  server.registerTool('imap_folder_status', {
    description: 'Get status information about a folder',
    inputSchema: {
      accountId,
      folder: z.string().describe('Folder name'),
    },
  }, withErrorHandling(async ({ accountId, folder }) => {
    const box = await imapService.selectFolder(accountId, folder);
    return jsonResult({
      folder,
      messages: {
        total: box.messages.total,
        new: box.messages.new,
        unseen: box.messages.unseen || 0,
      },
      uidvalidity: box.uidvalidity,
      uidnext: box.uidnext,
      flags: box.flags,
      permanentFlags: box.permanentFlags,
    });
  }));

  server.registerTool('imap_get_unread_count', {
    description: 'Get the count of unread emails in specified folders',
    inputSchema: {
      accountId,
      folders: z.array(z.string()).optional().describe('List of folders to check (default: all)'),
    },
  }, withErrorHandling(async ({ accountId, folders }) => {
    const targets = folders ?? (await imapService.listFolders(accountId)).map((f) => f.name);

    const byFolder: Record<string, number> = {};
    let totalUnread = 0;

    for (const name of targets) {
      let count = 0;
      try {
        const unread = await imapService.searchEmails(accountId, name, { seen: false });
        count = unread.length;
      } catch {
        // Folder unreadable (e.g. \Noselect) — report zero rather than failing.
        count = 0;
      }
      byFolder[name] = count;
      totalUnread += count;
    }

    return jsonResult({ totalUnread, byFolder });
  }));

  server.registerTool('imap_create_folder', {
    description: 'Create a new folder/mailbox in an IMAP account',
    inputSchema: {
      accountId,
      folderName: z.string().describe('Name of the folder to create (use "/" for hierarchy, e.g., "Archive/2024")'),
    },
  }, withErrorHandling(async ({ accountId, folderName }) => {
    await imapService.createFolder(accountId, folderName);
    return confirm(`Folder "${folderName}" created successfully`);
  }));

  server.registerTool('imap_delete_folder', {
    description: 'Delete a folder/mailbox from an IMAP account',
    inputSchema: {
      accountId,
      folderName: z.string().describe('Name of the folder to delete'),
    },
  }, withErrorHandling(async ({ accountId, folderName }) => {
    await imapService.deleteFolder(accountId, folderName);
    return confirm(`Folder "${folderName}" deleted successfully`);
  }));

  server.registerTool('imap_rename_folder', {
    description: 'Rename a folder/mailbox in an IMAP account',
    inputSchema: {
      accountId,
      oldName: z.string().describe('Current name of the folder'),
      newName: z.string().describe('New name for the folder'),
    },
  }, withErrorHandling(async ({ accountId, oldName, newName }) => {
    await imapService.renameFolder(accountId, oldName, newName);
    return confirm(`Folder renamed from "${oldName}" to "${newName}" successfully`);
  }));

  // RFC 9051: Subscribe to mailbox (Issue #53)
  server.registerTool('imap_subscribe_mailbox', {
    description: 'Subscribe to a mailbox (RFC 9051 SUBSCRIBE command)',
    inputSchema: {
      accountId,
      mailboxName: z.string().describe('Name of the mailbox to subscribe to'),
    },
  }, withErrorHandling(async ({ accountId, mailboxName }) => {
    await imapService.subscribeMailbox(accountId, mailboxName);
    return confirm(`Subscribed to mailbox "${mailboxName}" successfully`);
  }));

  // RFC 9051: Unsubscribe from mailbox (Issue #53)
  server.registerTool('imap_unsubscribe_mailbox', {
    description: 'Unsubscribe from a mailbox (RFC 9051 UNSUBSCRIBE command)',
    inputSchema: {
      accountId,
      mailboxName: z.string().describe('Name of the mailbox to unsubscribe from'),
    },
  }, withErrorHandling(async ({ accountId, mailboxName }) => {
    await imapService.unsubscribeMailbox(accountId, mailboxName);
    return confirm(`Unsubscribed from mailbox "${mailboxName}" successfully`);
  }));

  // RFC 9051: List subscribed mailboxes (Issue #53)
  server.registerTool('imap_list_subscribed_mailboxes', {
    description: 'List all subscribed mailboxes (RFC 9051 LSUB/LIST with SUBSCRIBED)',
    inputSchema: { accountId },
  }, withErrorHandling(async ({ accountId }) => {
    const subscribed = await imapService.listSubscribedMailboxes(accountId);
    return jsonResult({
      subscribedMailboxes: subscribed.map(summarizeFolder),
      count: subscribed.length,
    });
  }));

  // RFC 9051: Get mailbox status (Issue #56)
  server.registerTool('imap_get_mailbox_status', {
    description: 'Get mailbox statistics without selecting it (RFC 9051 STATUS command) - more efficient than SELECT',
    inputSchema: {
      accountId,
      mailboxName: z.union([z.string(), z.array(z.string())]).describe('Mailbox name or array of mailbox names'),
    },
  }, withErrorHandling(async ({ accountId, mailboxName }) => {
    const mailboxes = Array.isArray(mailboxName) ? mailboxName : [mailboxName];
    const statuses = await imapService.getMultipleMailboxStatus(accountId, mailboxes);

    const totalMessages = statuses.reduce((sum, s) => sum + s.messages, 0);
    const totalUnseen = statuses.reduce((sum, s) => sum + s.unseen, 0);
    const totalSize = statuses.reduce((sum, s) => sum + (s.size || 0), 0);

    return jsonResult({
      summary: {
        totalMailboxes: statuses.length,
        totalMessages,
        totalUnseen,
        totalSize: totalSize > 0 ? humanBytes(totalSize) : 'N/A',
      },
      mailboxes: statuses.map((status) => ({
        mailbox: status.mailbox,
        messages: status.messages,
        unseen: status.unseen,
        uidNext: status.uidNext,
        uidValidity: status.uidValidity.toString(),
        deleted: status.deleted,
        size: status.size ? humanBytes(status.size) : undefined,
      })),
    });
  }));
}
