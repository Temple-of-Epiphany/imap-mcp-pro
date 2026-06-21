// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Route tests for the core email MCP tools (search / get / mark / delete).
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
//
// These handlers were materially reworked for bulk actions + IMAP4rev2; this
// suite locks the inline-response contract that the #166 re-expression touched.
// emailTools is registered with no ResultsService so search uses the inline
// path (the handle/file path is exercised elsewhere).

import { describe, expect, it, beforeEach } from 'vitest';
import { emailTools } from './email-tools.js';

interface Registered { spec: any; handler: (args: any) => Promise<any>; }

function makeServer() {
  const tools = new Map<string, Registered>();
  const server = { registerTool: (name: string, spec: any, handler: any) => tools.set(name, { spec, handler }) };
  return { server, tools };
}

async function invoke(tools: Map<string, Registered>, name: string, args: any) {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return JSON.parse((await entry.handler(args)).content[0].text);
}

function makeImap(overrides: Record<string, any> = {}) {
  return {
    lastCriteria: undefined as any,
    searchEmails: async function (this: any, _a: string, _f: string, criteria: any) {
      this.lastCriteria = criteria;
      return [
        { uid: 1, subject: 'Hello', from: 'a@x.com', to: ['me@x.com'], date: new Date('2026-01-01'), flags: ['\\Seen'] },
        { uid: 2, subject: 'Re: Hello', from: 'b@x.com', to: ['me@x.com'], date: new Date('2026-01-02'), flags: [] },
      ];
    },
    getEmailContent: async () => ({
      uid: 1, subject: 'Hello', from: 'a@x.com',
      textContent: 'T'.repeat(20000), htmlContent: 'H'.repeat(20000),
    }),
    markAsRead: async () => {},
    markAsUnread: async () => {},
    deleteEmail: async () => {},
    getEmailSizes: async () => [
      { uid: 1, size: 2048, subject: 'small', from: 'a@x.com', date: new Date('2026-01-01'), hasAttachments: false },
      { uid: 2, size: 15 * 1024 * 1024, subject: 'big', from: 'b@x.com', date: new Date('2026-01-02'), hasAttachments: true },
      { uid: 3, size: 5 * 1024 * 1024, subject: 'medium', from: 'c@x.com', date: new Date('2026-01-03'), hasAttachments: true },
    ],
    ...overrides,
  };
}

function register(imap: any, db: any = {}, smtp: any = {}) {
  const { server, tools } = makeServer();
  // results/workerPool/etc. omitted → search uses the inline path.
  emailTools(server as any, imap as any, db as any, smtp as any);
  return tools;
}

function dbWithAccount(overrides: Record<string, any> = {}) {
  return {
    getDecryptedAccount: () => ({
      account_id: 'acc-1', name: 'Me', host: 'imap.x.com', port: 993,
      username: 'me@x.com', password: 'pw', tls: true,
      smtp_host: 'smtp.x.com', smtp_port: 465, smtp_secure: true,
      smtp_username: 'me@x.com', smtp_password: 'pw',
    }),
    ...overrides,
  };
}

describe('emailTools core routes', () => {
  let imap: any;
  let tools: Map<string, Registered>;
  beforeEach(() => { imap = makeImap(); tools = register(imap); });

  it('registers the core email routes', () => {
    for (const name of ['imap_search_emails', 'imap_get_email', 'imap_mark_as_read', 'imap_mark_as_unread', 'imap_delete_email']) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it('imap_search_emails returns the inline result shape', async () => {
    const out = await invoke(tools, 'imap_search_emails', { accountId: 'a', folder: 'INBOX', limit: 50 });
    expect(out.totalFound).toBe(2);
    expect(out.returned).toBe(2);
    expect(out.messages).toHaveLength(2);
    expect(out.warnings).toBeUndefined();
  });

  it('imap_search_emails maps only provided criteria and parses dates locally', async () => {
    await invoke(tools, 'imap_search_emails', { accountId: 'a', folder: 'INBOX', from: 'x@y.com', subject: 'hi', since: '2026-04-01', unreadOnly: true });
    expect(imap.lastCriteria).toMatchObject({ from: 'x@y.com', subject: 'hi', unreadOnly: true });
    expect(imap.lastCriteria).not.toHaveProperty('to');
    expect(imap.lastCriteria).not.toHaveProperty('flagged');
    // YYYY-MM-DD parsed as local midnight (not UTC) — Issue #91
    expect(imap.lastCriteria.since.getFullYear()).toBe(2026);
    expect(imap.lastCriteria.since.getMonth()).toBe(3);
    expect(imap.lastCriteria.since.getDate()).toBe(1);
    expect(imap.lastCriteria.since.getHours()).toBe(0);
  });

  it('imap_search_emails warns and truncates when results exceed the limit', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ uid: i, subject: 's', from: 'f', to: [], date: new Date(), flags: [] }));
    const t = register(makeImap({ searchEmails: async () => many }));
    const out = await invoke(t, 'imap_search_emails', { accountId: 'a', folder: 'INBOX', limit: 2 });
    expect(out.returned).toBe(2);
    expect(out.totalFound).toBe(5);
    expect(out.warnings?.some((w: string) => w.includes('returning only'))).toBe(true);
  });

  it('imap_get_email clips text and html bodies to 10000 chars', async () => {
    const out = await invoke(tools, 'imap_get_email', { accountId: 'a', folder: 'INBOX', uid: 1 });
    expect(out.email.textContent).toHaveLength(10000);
    expect(out.email.htmlContent).toHaveLength(10000);
    expect(out.email.subject).toBe('Hello');
  });

  it('imap_mark_as_read / mark_as_unread / delete_email return confirmations', async () => {
    expect(await invoke(tools, 'imap_mark_as_read', { accountId: 'a', folder: 'INBOX', uid: 7 }))
      .toEqual({ success: true, message: 'Email 7 marked as read' });
    expect(await invoke(tools, 'imap_mark_as_unread', { accountId: 'a', folder: 'INBOX', uid: 7 }))
      .toEqual({ success: true, message: 'Email 7 marked as unread' });
    expect(await invoke(tools, 'imap_delete_email', { accountId: 'a', folder: 'INBOX', uid: 7 }))
      .toEqual({ success: true, message: 'Email 7 deleted' });
  });

  it('imap_get_latest_emails returns newest-first, capped to count', async () => {
    const out = await invoke(tools, 'imap_get_latest_emails', { accountId: 'a', folder: 'INBOX', count: 1 });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].uid).toBe(2); // 2026-01-02 is newer than 2026-01-01
  });

  it('imap_get_email_sizes returns largest-first with human-readable sizes + uids', async () => {
    const out = await invoke(tools, 'imap_get_email_sizes', { accountId: 'a', folder: 'INBOX' });
    expect(out.scanned).toBe(3);
    expect(out.messages.map((m: any) => m.uid)).toEqual([2, 3, 1]); // size desc
    expect(out.messages[0]).toMatchObject({ uid: 2, size: 15 * 1024 * 1024, sizeHuman: '15.00 MB', hasAttachments: true });
    expect(out.messages[2].sizeHuman).toBe('2.00 KB');
    expect(out.uids).toEqual([2, 3, 1]); // ready for bulk delete/move
    expect(out.totalMatchedHuman).toBe('20.00 MB');
  });

  it('imap_get_email_sizes filters by minSizeBytes and respects limit + asc order', async () => {
    const big = await invoke(tools, 'imap_get_email_sizes', { accountId: 'a', folder: 'INBOX', minSizeBytes: 10 * 1024 * 1024 });
    expect(big.matched).toBe(1);
    expect(big.messages.map((m: any) => m.uid)).toEqual([2]);

    const asc = await invoke(tools, 'imap_get_email_sizes', { accountId: 'a', folder: 'INBOX', order: 'asc', limit: 2 });
    expect(asc.returned).toBe(2);
    expect(asc.messages.map((m: any) => m.uid)).toEqual([1, 3]); // smallest first, capped
  });
});

describe('imap_get_largest_emails (multi-folder, #200)', () => {
  // Folder-aware mock: INBOX and Sent return distinct sizes; "Junk" throws (e.g. \Noselect).
  function multiFolderImap() {
    return makeImap({
      getEmailSizes: async (_a: string, folder: string) => {
        if (folder === 'INBOX') return [
          { uid: 10, size: 3 * 1024 * 1024, subject: 'inbox-mid', from: 'a@x.com', date: new Date('2026-01-01'), hasAttachments: false },
          { uid: 11, size: 1 * 1024 * 1024, subject: 'inbox-small', from: 'b@x.com', date: new Date('2026-01-02'), hasAttachments: false },
        ];
        if (folder === 'Sent') return [
          { uid: 20, size: 9 * 1024 * 1024, subject: 'sent-big', from: 'me@x.com', date: new Date('2026-02-01'), hasAttachments: true },
          { uid: 21, size: 2 * 1024 * 1024, subject: 'sent-small', from: 'me@x.com', date: new Date('2026-02-02'), hasAttachments: false },
        ];
        throw new Error(`Mailbox does not exist: ${folder}`);
      },
    });
  }

  it('defaults to INBOX only and ranks largest-first', async () => {
    const tools = register(multiFolderImap());
    const out = await invoke(tools, 'imap_get_largest_emails', { accountId: 'a' });
    expect(out.foldersScanned).toEqual(['INBOX']);
    expect(out.messages.map((m: any) => m.uid)).toEqual([10, 11]);
    expect(out.messages[0].folder).toBe('INBOX');
  });

  it('merges and ranks across folders with per-folder uid arrays', async () => {
    const tools = register(multiFolderImap());
    const out = await invoke(tools, 'imap_get_largest_emails', { accountId: 'a', folders: ['INBOX', 'Sent'], topN: 3 });
    expect(out.returned).toBe(3);
    // global size-desc: Sent#20 (9M), INBOX#10 (3M), Sent#21 (2M) — INBOX#11 (1M) drops off at topN=3
    expect(out.messages.map((m: any) => `${m.folder}:${m.uid}`)).toEqual(['Sent:20', 'INBOX:10', 'Sent:21']);
    expect(out.uidsByFolder).toEqual({ Sent: [20, 21], INBOX: [10] });
    expect(out.totalHuman).toBe('14.00 MB');
  });

  it('skips unreadable folders and reports them', async () => {
    const tools = register(multiFolderImap());
    const out = await invoke(tools, 'imap_get_largest_emails', { accountId: 'a', folders: ['INBOX', 'Junk'] });
    expect(out.foldersScanned).toEqual(['INBOX']);
    expect(out.skippedFolders).toHaveLength(1);
    expect(out.skippedFolders[0].folder).toBe('Junk');
    expect(out.skippedFolders[0].reason).toMatch(/does not exist/);
  });

  it('applies minSizeBytes across all folders', async () => {
    const tools = register(multiFolderImap());
    const out = await invoke(tools, 'imap_get_largest_emails', { accountId: 'a', folders: ['INBOX', 'Sent'], minSizeBytes: 3 * 1024 * 1024 });
    expect(out.messages.map((m: any) => `${m.folder}:${m.uid}`)).toEqual(['Sent:20', 'INBOX:10']);
  });
});

describe('emailTools send/reply/forward', () => {
  it('imap_reply_to_email builds Re: subject, threads, and reply-all recipients', async () => {
    let sent: any;
    const smtp = { sendEmail: async (_a: string, _acc: any, composer: any) => { sent = composer; return '<msg@x>'; } };
    const imap = makeImap({
      getEmailContent: async () => ({ uid: 5, subject: 'Status', from: 'boss@x.com', to: ['me@x.com', 'peer@x.com'], messageId: '<orig@x>' }),
    });
    const tools = register(imap, dbWithAccount(), smtp);
    const out = await invoke(tools, 'imap_reply_to_email', { accountId: 'a', folder: 'INBOX', uid: 5, text: 'ok', replyAll: true });
    expect(out).toEqual({ success: true, messageId: '<msg@x>', message: 'Reply sent successfully' });
    expect(sent.subject).toBe('Re: Status');
    expect(sent.inReplyTo).toBe('<orig@x>');
    expect(sent.references).toBe('<orig@x>');
    // reply-all includes original recipients except self
    expect(sent.to).toEqual(['boss@x.com', 'peer@x.com']);
  });

  it('imap_reply_to_email keeps an existing Re: prefix and excludes self on reply-all', async () => {
    let sent: any;
    const smtp = { sendEmail: async (_a: string, _acc: any, c: any) => { sent = c; return '<m>'; } };
    const imap = makeImap({
      getEmailContent: async () => ({ uid: 5, subject: 'Re: Hi', from: 'a@x.com', to: ['me@x.com'], messageId: '<o>' }),
    });
    const tools = register(imap, dbWithAccount(), smtp);
    await invoke(tools, 'imap_reply_to_email', { accountId: 'a', folder: 'INBOX', uid: 5, text: 'y', replyAll: true });
    expect(sent.subject).toBe('Re: Hi');
    expect(sent.to).toEqual(['a@x.com']); // 'me@x.com' (self) filtered out
  });

  it('imap_forward_email builds Fwd: subject and a forwarded-message header', async () => {
    let sent: any;
    const smtp = { sendEmail: async (_a: string, _acc: any, c: any) => { sent = c; return '<f>'; } };
    const imap = makeImap({
      getEmailContent: async () => ({ uid: 9, subject: 'Doc', from: 'a@x.com', to: ['b@x.com'], date: new Date('2026-01-01T00:00:00Z'), messageId: '<o>', textContent: 'BODY' }),
    });
    const tools = register(imap, dbWithAccount(), smtp);
    const out = await invoke(tools, 'imap_forward_email', { accountId: 'a', folder: 'INBOX', uid: 9, to: 'c@x.com', text: 'FYI' });
    expect(out).toEqual({ success: true, messageId: '<f>', message: 'Email forwarded successfully' });
    expect(sent.subject).toBe('Fwd: Doc');
    expect(sent.to).toBe('c@x.com');
    expect(sent.text).toContain('FYI');
    expect(sent.text).toContain('Forwarded message');
    expect(sent.text).toContain('BODY');
  });
});
