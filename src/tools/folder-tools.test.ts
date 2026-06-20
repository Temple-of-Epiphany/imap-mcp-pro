// SPDX-License-Identifier: LicenseRef-ImapMcpPro-Dual
//
// Route tests for the folder/mailbox MCP tools.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
//
// Registers folderTools against a mock McpServer + mock ImapService and
// asserts every tool is registered and returns the expected JSON payload.
// Locks the output contract so the clean-room refactors (#166) cannot drift.

import { describe, expect, it, beforeEach } from 'vitest';
import { folderTools } from './folder-tools.js';

interface Registered {
  spec: any;
  handler: (args: any) => Promise<any>;
}

/** Minimal McpServer stand-in that records registered tools. */
function makeServer() {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(name: string, spec: any, handler: any) {
      tools.set(name, { spec, handler });
    },
  };
  return { server, tools };
}

/** Invoke a registered tool and parse its JSON text payload. */
async function invoke(tools: Map<string, Registered>, name: string, args: any) {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  const result = await entry.handler(args);
  return JSON.parse(result.content[0].text);
}

function makeImapMock(overrides: Record<string, any> = {}) {
  return {
    listFolders: async () => [
      { name: 'INBOX', delimiter: '/', attributes: ['\\HasNoChildren'], children: [] },
      { name: 'Archive', delimiter: '/', attributes: ['\\HasChildren'], children: [{ name: 'Archive/2024' }] },
    ],
    selectFolder: async () => ({
      messages: { total: 10, new: 2, unseen: 3 },
      uidvalidity: 5, uidnext: 11, flags: ['\\Seen'], permanentFlags: ['\\Seen'],
    }),
    searchEmails: async (_a: string, name: string) => {
      if (name === 'BadFolder') throw new Error('\\Noselect');
      return [{}, {}];
    },
    createFolder: async () => {},
    deleteFolder: async () => {},
    renameFolder: async () => {},
    subscribeMailbox: async () => {},
    unsubscribeMailbox: async () => {},
    listSubscribedMailboxes: async () => [
      { name: 'INBOX', delimiter: '/', attributes: [], children: [] },
    ],
    getMultipleMailboxStatus: async () => [
      { mailbox: 'INBOX', messages: 10, unseen: 3, uidNext: 11, uidValidity: 5n, deleted: 0, size: 2 * 1024 * 1024 },
    ],
    ...overrides,
  };
}

describe('folderTools registration', () => {
  it('registers all folder/mailbox routes', () => {
    const { server, tools } = makeServer();
    folderTools(server as any, makeImapMock() as any, {} as any);
    expect([...tools.keys()].sort()).toEqual([
      'imap_create_folder',
      'imap_delete_folder',
      'imap_folder_status',
      'imap_get_mailbox_status',
      'imap_get_unread_count',
      'imap_list_folders',
      'imap_list_subscribed_mailboxes',
      'imap_rename_folder',
      'imap_subscribe_mailbox',
      'imap_unsubscribe_mailbox',
    ]);
  });
});

describe('folderTools route outputs', () => {
  let tools: Map<string, Registered>;
  beforeEach(() => {
    const made = makeServer();
    tools = made.tools;
    folderTools(made.server as any, makeImapMock() as any, {} as any);
  });

  it('imap_list_folders summarizes folders with hasChildren', async () => {
    const out = await invoke(tools, 'imap_list_folders', { accountId: 'a' });
    expect(out).toEqual({
      folders: [
        { name: 'INBOX', delimiter: '/', attributes: ['\\HasNoChildren'], hasChildren: false },
        { name: 'Archive', delimiter: '/', attributes: ['\\HasChildren'], hasChildren: true },
      ],
    });
  });

  it('imap_folder_status returns message + uid metadata', async () => {
    const out = await invoke(tools, 'imap_folder_status', { accountId: 'a', folder: 'INBOX' });
    expect(out).toEqual({
      folder: 'INBOX',
      messages: { total: 10, new: 2, unseen: 3 },
      uidvalidity: 5, uidnext: 11, flags: ['\\Seen'], permanentFlags: ['\\Seen'],
    });
  });

  it('imap_get_unread_count counts per folder and skips unreadable folders as 0', async () => {
    const out = await invoke(tools, 'imap_get_unread_count', { accountId: 'a', folders: ['INBOX', 'BadFolder'] });
    expect(out).toEqual({ totalUnread: 2, byFolder: { INBOX: 2, BadFolder: 0 } });
  });

  it('imap_get_unread_count defaults to all folders when none given', async () => {
    const out = await invoke(tools, 'imap_get_unread_count', { accountId: 'a' });
    expect(out.byFolder).toHaveProperty('INBOX');
    expect(out.byFolder).toHaveProperty('Archive');
  });

  it('imap_create_folder / delete / rename return success confirmations', async () => {
    expect(await invoke(tools, 'imap_create_folder', { accountId: 'a', folderName: 'X' }))
      .toEqual({ success: true, message: 'Folder "X" created successfully' });
    expect(await invoke(tools, 'imap_delete_folder', { accountId: 'a', folderName: 'X' }))
      .toEqual({ success: true, message: 'Folder "X" deleted successfully' });
    expect(await invoke(tools, 'imap_rename_folder', { accountId: 'a', oldName: 'X', newName: 'Y' }))
      .toEqual({ success: true, message: 'Folder renamed from "X" to "Y" successfully' });
  });

  it('imap_subscribe / unsubscribe return success confirmations', async () => {
    expect(await invoke(tools, 'imap_subscribe_mailbox', { accountId: 'a', mailboxName: 'M' }))
      .toEqual({ success: true, message: 'Subscribed to mailbox "M" successfully' });
    expect(await invoke(tools, 'imap_unsubscribe_mailbox', { accountId: 'a', mailboxName: 'M' }))
      .toEqual({ success: true, message: 'Unsubscribed from mailbox "M" successfully' });
  });

  it('imap_list_subscribed_mailboxes returns summaries + count', async () => {
    const out = await invoke(tools, 'imap_list_subscribed_mailboxes', { accountId: 'a' });
    expect(out).toEqual({
      subscribedMailboxes: [{ name: 'INBOX', delimiter: '/', attributes: [], hasChildren: false }],
      count: 1,
    });
  });

  it('imap_get_mailbox_status aggregates summary and formats sizes', async () => {
    const out = await invoke(tools, 'imap_get_mailbox_status', { accountId: 'a', mailboxName: 'INBOX' });
    expect(out.summary).toEqual({ totalMailboxes: 1, totalMessages: 10, totalUnseen: 3, totalSize: '2.00 MB' });
    expect(out.mailboxes[0]).toEqual({
      mailbox: 'INBOX', messages: 10, unseen: 3, uidNext: 11, uidValidity: '5', deleted: 0, size: '2.00 MB',
    });
  });

  it('imap_get_mailbox_status accepts a single name or an array', async () => {
    const single = await invoke(tools, 'imap_get_mailbox_status', { accountId: 'a', mailboxName: 'INBOX' });
    const array = await invoke(tools, 'imap_get_mailbox_status', { accountId: 'a', mailboxName: ['INBOX'] });
    expect(single).toEqual(array);
  });
});
