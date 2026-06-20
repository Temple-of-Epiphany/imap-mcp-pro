// SPDX-License-Identifier: LicenseRef-ImapMcpPro-Dual
//
// HTTP route tests for WebUIServer.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
//
// Constructs WebUIServer with injected mock DatabaseService + ImapService,
// mounts its Express app on an ephemeral port, and exercises the account
// routes over real HTTP via fetch — no new test dependency required. Locks
// the route contract that the #166 re-expression touched.

import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebUIServer } from './server.js';

let created: any[] = [];
let deleted: string[] = [];
let updated: { id: string; updates: any }[] = [];

function makeDb() {
  return {
    getUserByUsername: (username: string) => ({ user_id: 'u1', username, is_active: true }),
    createUser: (u: any) => u,
    listDecryptedAccountsForUser: () => [
      { account_id: 'a1', name: 'Work', username: 'me@x.com', host: 'imap.x.com', port: 993, tls: true,
        smtp_host: 'smtp.x.com', smtp_port: 465, smtp_secure: true },
      { account_id: 'a2', name: 'Plain', username: 'p@y.com', host: 'imap.y.com', port: 993, tls: true,
        smtp_host: undefined },
    ],
    createAccount: (input: any) => { created.push(input); return { account_id: 'new-1', ...input }; },
    deleteAccount: (id: string) => { deleted.push(id); },
    updateAccount: (id: string, updates: any) => { updated.push({ id, updates }); },
    getAccount: (id: string) => ({ account_id: id, name: 'Renamed', username: 'me@x.com', host: 'imap.x.com', port: 993, tls: true }),
  } as any;
}

const imap = {
  connect: async () => {},
  disconnect: async () => {},
  listFolders: async () => [],
} as any;

let server: http.Server;
let base: string;

beforeAll(async () => {
  const ui = new WebUIServer({ port: 0, db: makeDb(), imapService: imap });
  const app = (ui as any).app;
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => { created = []; deleted = []; updated = []; });

describe('WebUIServer /api routes', () => {
  it('GET /api/providers returns the provider catalog', async () => {
    const res = await fetch(`${base}/api/providers`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.find((p: any) => p.id === 'gmail')).toBeTruthy();
  });

  it('GET /api/accounts maps rows to web shape, including SMTP only when configured', async () => {
    const res = await fetch(`${base}/api/accounts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toEqual({
      id: 'a1', name: 'Work', user: 'me@x.com', host: 'imap.x.com', port: 993, tls: true,
      smtp: { host: 'smtp.x.com', port: 465, tls: true },
    });
    expect(body[1].smtp).toBeUndefined();
  });

  it('POST /api/accounts auto-detects IMAP settings from the email domain', async () => {
    const res = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'G', email: 'me@gmail.com', password: 'pw' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.account).toEqual({ id: 'new-1', name: 'G', user: 'me@gmail.com', host: 'imap.gmail.com', port: 993, tls: true });
    expect(created[0]).toMatchObject({ host: 'imap.gmail.com', port: 993, username: 'me@gmail.com', tls: true });
  });

  it('POST /api/accounts honors an explicit host over auto-detect', async () => {
    const res = await fetch(`${base}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Custom', email: 'me@corp.com', password: 'pw', host: 'mail.corp.com', port: 143, tls: false }),
    });
    const body = await res.json();
    expect(body.account.host).toBe('mail.corp.com');
    expect(created[0]).toMatchObject({ host: 'mail.corp.com', port: 143, tls: false });
  });

  it('PUT /api/accounts/:id sends only defined fields and maps email→username', async () => {
    const res = await fetch(`${base}/api/accounts/a1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', email: 'me@x.com' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual({ id: 'a1', updates: { name: 'Renamed', username: 'me@x.com' } });
    // undefined fields (password/host/port/tls) are omitted, not nulled
    expect(updated[0].updates).not.toHaveProperty('password');
    expect(updated[0].updates).not.toHaveProperty('host');
  });

  it('DELETE /api/accounts/:id disconnects and deletes', async () => {
    const res = await fetch(`${base}/api/accounts/a1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(deleted).toEqual(['a1']);
  });
});
