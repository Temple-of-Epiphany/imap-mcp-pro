// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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


// ---------------------------------------------------------------------------
// #298 — Host-header allowlist + hardening headers
// ---------------------------------------------------------------------------
describe('WebUIServer Host-header allowlist (#298)', () => {
  it('isAllowedHost accepts loopback names with or without a port', () => {
    for (const h of ['localhost', 'localhost:4500', '127.0.0.1', '127.0.0.1:65000', '[::1]', '[::1]:4500', 'LOCALHOST:4500']) {
      expect(WebUIServer.isAllowedHost(h), h).toBe(true);
    }
  });

  it('isAllowedHost rejects foreign, spoofed and missing hosts', () => {
    for (const h of [undefined, '', 'evil.example', 'evil.example:4500', 'localhost.evil.example', '127.0.0.1.evil.example',
                     '127.0.0.2', '0.0.0.0', '[::ffff:127.0.0.1]', 'localhost:4500:1', 'localhost/']) {
      expect(WebUIServer.isAllowedHost(h), String(h)).toBe(false);
    }
  });
});

describe('WebUIServer request hardening (#298)', () => {
  let server: http.Server;
  let base: string;
  let port: number;

  beforeAll(async () => {
    const imap: any = {};
    const ui = new WebUIServer({ port: 0, db: makeDb(), imapService: imap });
    server = http.createServer((ui as any).app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  function raw(hostHeader: string, path = '/api/providers'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: hostHeader }, setHost: false }, (res) => {
        let body = ''; res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject); req.end();
    });
  }

  it('answers requests addressed to localhost', async () => {
    const r = await raw(`localhost:${port}`);
    expect(r.status).toBe(200);
  });

  it('refuses a foreign Host header with 403 before any route runs', async () => {
    const r = await raw('attacker.example');
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toMatchObject({ success: false });
    // a mutating route is refused the same way
    const r2 = await raw('attacker.example:4500', '/api/service/port');
    expect(r2.status).toBe(403);
  });

  it('sets hardening headers on every response', async () => {
    const r = await raw(`127.0.0.1:${port}`);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['strict-transport-security']).toBeUndefined();
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('https://dns.quad9.net');
    expect(csp).toContain('https://cdn.jsdelivr.net');
    expect(csp).toContain("object-src 'none'");
  });
});


// ---------------------------------------------------------------------------
// #329 — /api/accounts/status must not be shadowed by /api/accounts/:id
// ---------------------------------------------------------------------------
describe('GET /api/accounts/status (#329)', () => {
  let server: http.Server; let base: string;
  const imap: any = { connectionMetadata: new Map() };
  beforeAll(async () => {
    const ui = new WebUIServer({ port: 0, db: makeDb(), imapService: imap });
    server = http.createServer((ui as any).app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('returns 200 with an accounts array instead of the :id route\'s 404', async () => {
    const r = await fetch(`${base}/api/accounts/status`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.accounts)).toBe(true);
  });

  it('lists the accounts owned by the Web UI user (looked up by user id, not username)', async () => {
    const body = await (await fetch(`${base}/api/accounts/status`)).json();
    const emails = body.accounts.map((a: any) => a.email);
    expect(emails).toContain('me@x.com'); // seeded by makeDb for the default user
    expect(body.accounts.every((a: any) => a.status === 'disconnected')).toBe(true);
  });
});
