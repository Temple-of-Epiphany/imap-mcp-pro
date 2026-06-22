// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// RFC 9051 (IMAP4rev2) compliance regression suite (#57).
//
// Asserts that every RFC 9051 command this server implements stays wired:
// each required command maps to a registered MCP tool AND to a backing
// ImapService method. This guards against silently dropping a required
// capability during a refactor. (It is a structural/contract test — live
// protocol conformance against a real server is exercised by the manual test
// plan, not CI.)

import { describe, expect, it } from 'vitest';
import { folderTools } from './folder-tools.js';
import { emailTools } from './email-tools.js';
import { capabilityTools } from './capability-tools.js';
import { ImapService } from '../services/imap-service.js';

function collectToolNames(): Set<string> {
  const names = new Set<string>();
  const server: any = { registerTool: (name: string) => names.add(name) };
  const stub: any = {};
  // Registration only stores specs/handlers; services are never invoked here,
  // so empty stubs are sufficient to enumerate the registered tool names.
  folderTools(server, stub, stub);
  emailTools(server, stub, stub, stub);
  capabilityTools(server, stub, stub);
  return names;
}

// RFC 9051 command → exposing MCP tool → backing ImapService method.
const REQUIRED: Array<{ command: string; tool: string; method: keyof ImapService }> = [
  { command: 'CREATE',      tool: 'imap_create_folder',           method: 'createFolder' },
  { command: 'DELETE',      tool: 'imap_delete_folder',           method: 'deleteFolder' },
  { command: 'RENAME',      tool: 'imap_rename_folder',           method: 'renameFolder' },
  { command: 'SUBSCRIBE',   tool: 'imap_subscribe_mailbox',       method: 'subscribeMailbox' },
  { command: 'UNSUBSCRIBE', tool: 'imap_unsubscribe_mailbox',     method: 'unsubscribeMailbox' },
  { command: 'LIST (LSUB)', tool: 'imap_list_subscribed_mailboxes', method: 'listSubscribedMailboxes' },
  { command: 'LIST',        tool: 'imap_list_folders',            method: 'listFolders' },
  { command: 'STATUS',      tool: 'imap_get_mailbox_status',      method: 'getMailboxStatus' },
  { command: 'APPEND',      tool: 'imap_append_message',          method: 'appendMessage' },
  { command: 'SEARCH',      tool: 'imap_search_emails',           method: 'searchEmails' },
  { command: 'COPY',        tool: 'imap_bulk_copy_emails',        method: 'bulkCopyEmails' },
  { command: 'MOVE',        tool: 'imap_bulk_move_emails',        method: 'bulkMoveEmails' },
  { command: 'STORE',       tool: 'imap_bulk_mark_emails',        method: 'bulkMarkEmails' },
  { command: 'CAPABILITY',  tool: 'imap_get_capabilities',        method: 'getCapabilities' },
];

describe('RFC 9051 (IMAP4rev2) compliance (#57)', () => {
  const tools = collectToolNames();

  it.each(REQUIRED)('$command is exposed as $tool', ({ tool }) => {
    expect(tools.has(tool)).toBe(true);
  });

  it.each(REQUIRED)('$command is backed by ImapService.$method', ({ method }) => {
    expect(typeof (ImapService.prototype as any)[method]).toBe('function');
  });

  it('exposes the QUOTA extension (RFC 9208) it advertises', () => {
    expect(typeof (ImapService.prototype as any).getQuota).toBe('function');
  });
});
