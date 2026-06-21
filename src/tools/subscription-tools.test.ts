// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for imap_extract_unsubscribe_links — header-first extraction, body
// fallback, time budget, and afterUid resume (#131).

import { describe, expect, it, beforeEach } from 'vitest';
import { registerSubscriptionTools } from './subscription-tools.js';

type Registered = { spec: any; handler: any };

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

function headerBuf(value: string | null): Buffer | null {
  return value == null ? null : Buffer.from(`List-Unsubscribe: ${value}\r\n`);
}

// Three messages: uid 1 has a header, uid 2 has no header (body link), uid 3 has nothing.
function makeImap(overrides: Record<string, any> = {}) {
  const calls = { getEmailContent: [] as number[], getUnsubscribeHeaders: [] as number[][] };
  const imap = {
    calls,
    searchEmails: async () => [
      { uid: 3, from: 'c@x.com', subject: 'three', date: new Date('2026-01-03') },
      { uid: 1, from: 'a@x.com', subject: 'one', date: new Date('2026-01-01') },
      { uid: 2, from: 'b@x.com', subject: 'two', date: new Date('2026-01-02') },
    ],
    getUnsubscribeHeaders: async (_a: string, _f: string, uids: number[]) => {
      calls.getUnsubscribeHeaders.push(uids);
      const headers: Record<number, string | null> = {
        1: '<https://unsub.example/one>',
        2: null,
        3: null,
      };
      return uids.map((uid) => ({
        uid,
        from: `uid${uid}@x.com`,
        subject: `subject-${uid}`,
        date: new Date('2026-01-0' + uid),
        headerBytes: headerBuf(headers[uid] ?? null),
      }));
    },
    getEmailContent: async (_a: string, _f: string, uid: number) => {
      calls.getEmailContent.push(uid);
      // Only uid 2 has an in-body unsubscribe link.
      const html = uid === 2 ? '<a href="https://body.example/unsubscribe">unsubscribe</a>' : '<p>nothing</p>';
      return { uid, textContent: '', htmlContent: html, from: `uid${uid}@x.com`, subject: `subject-${uid}` };
    },
    ...overrides,
  };
  return imap;
}

function makeDb() {
  const stored: any[] = [];
  return {
    stored,
    resolveUserId: () => 'user-1',
    insertUnsubscribeLink: (row: any) => stored.push(row),
    upsertSubscriptionSummary: () => {},
  };
}

function register(imap: any, db: any) {
  const { server, tools } = makeServer();
  registerSubscriptionTools(server as any, imap as any, db as any, {} as any);
  return tools;
}

describe('imap_extract_unsubscribe_links (#131)', () => {
  let imap: any, db: any, tools: Map<string, Registered>;
  beforeEach(() => { imap = makeImap(); db = makeDb(); tools = register(imap, db); });

  it('resolves header-first without a body fetch when List-Unsubscribe is present', async () => {
    const out = await invoke(tools, 'imap_extract_unsubscribe_links', {
      userId: 'user-1', accountId: 'a', folder: 'INBOX', scanBodies: false,
    });
    // uid 1 found via header; uids 2 & 3 have no header and bodies are skipped.
    expect(out.summary.processed).toBe(3);
    expect(out.summary.linksFound).toBe(1);
    expect(out.summary.bodyScans).toBe(0);
    expect(imap.calls.getEmailContent).toHaveLength(0);
    const found = out.emails.find((e: any) => e.uid === 1);
    expect(found.unsubscribe_link).toBe('https://unsub.example/one');
    expect(found.has_list_unsubscribe_header).toBe(true);
  });

  it('falls back to a body fetch only on header-miss when scanBodies is on', async () => {
    const out = await invoke(tools, 'imap_extract_unsubscribe_links', {
      userId: 'user-1', accountId: 'a', folder: 'INBOX', scanBodies: true,
    });
    // uid 1 from header (no body), uids 2 & 3 trigger a body fetch; only uid 2 yields a link.
    expect(imap.calls.getEmailContent.sort()).toEqual([2, 3]);
    expect(out.summary.bodyScans).toBe(2);
    expect(out.summary.linksFound).toBe(2);
    expect(out.emails.find((e: any) => e.uid === 2).unsubscribe_link).toContain('https://body.example/unsubscribe');
  });

  it('processes in ascending UID order and honors afterUid for resume', async () => {
    const out = await invoke(tools, 'imap_extract_unsubscribe_links', {
      userId: 'user-1', accountId: 'a', folder: 'INBOX', afterUid: 1, scanBodies: false,
    });
    // uid 1 skipped by the cursor; only 2 and 3 considered.
    expect(out.summary.processed).toBe(2);
    expect(imap.calls.getUnsubscribeHeaders[0]).toEqual([2, 3]);
  });

  it('returns a partial result with truncated + nextUid when the time budget is exceeded', async () => {
    const out = await invoke(tools, 'imap_extract_unsubscribe_links', {
      userId: 'user-1', accountId: 'a', folder: 'INBOX', maxDurationMs: -1,
    });
    expect(out.summary.truncated).toBe(true);
    expect(out.summary.processed).toBe(0);
    expect(out.summary.nextUid).toBe(0); // first uid (1) minus 1 → resume includes uid 1
    expect(out.summary.hint).toMatch(/afterUid: 0/);
  });

  it('stores found links to the database', async () => {
    await invoke(tools, 'imap_extract_unsubscribe_links', {
      userId: 'user-1', accountId: 'a', folder: 'INBOX', scanBodies: false,
    });
    expect(db.stored).toHaveLength(1);
    expect(db.stored[0]).toMatchObject({ user_id: 'user-1', account_id: 'a', uid: 1 });
  });
});
