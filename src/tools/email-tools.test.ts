// SPDX-License-Identifier: LicenseRef-ImapMcpPro-Dual
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
    ...overrides,
  };
}

function register(imap: any) {
  const { server, tools } = makeServer();
  // results/workerPool/etc. omitted → search uses the inline path.
  emailTools(server as any, imap as any, {} as any, {} as any);
  return tools;
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
});
