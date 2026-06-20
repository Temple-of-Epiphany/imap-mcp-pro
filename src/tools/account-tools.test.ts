// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Route tests for the account-management MCP tools.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
//
// Registers accountTools against mock DatabaseService + ImapService and
// asserts every route registers and returns the expected payload, including
// the provider-preset onboarding paths and error handling. Locks the output
// contract so the clean-room refactor (#166) cannot drift.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { accountTools } from './account-tools.js';

interface Registered { spec: any; handler: (args: any) => Promise<any>; }

function makeServer() {
  const tools = new Map<string, Registered>();
  const server = { registerTool: (name: string, spec: any, handler: any) => tools.set(name, { spec, handler }) };
  return { server, tools };
}

async function invoke(tools: Map<string, Registered>, name: string, args: any = {}) {
  const entry = tools.get(name);
  if (!entry) throw new Error(`tool not registered: ${name}`);
  return JSON.parse((await entry.handler(args)).content[0].text);
}

function makeDb(overrides: Record<string, any> = {}) {
  const created: any[] = [];
  const db: any = {
    created,
    getUserByUsername: (username: string) => ({ user_id: 'u1', username, is_active: true }),
    createAccount: (input: any) => { created.push(input); return { account_id: 'acc-1' }; },
    listDecryptedAccountsForUser: () => [
      { account_id: 'acc-1', name: 'Work', host: 'imap.example.com', port: 993, username: 'me', tls: true },
    ],
    deleteAccount: () => {},
    getDecryptedAccount: (id: string) =>
      id === 'missing' ? undefined
        : { account_id: id, user_id: 'u1', name: 'Work', host: 'h', port: 993, username: 'me', password: 'secret', tls: true },
    ...overrides,
  };
  return db;
}

function makeImap(overrides: Record<string, any> = {}) {
  return {
    connect: async () => {},
    disconnect: async () => {},
    testConnection: async () => ({ ok: true, folderCount: 5, inboxMessageCount: 3, durationMs: 12 }),
    ...overrides,
  };
}

describe('accountTools', () => {
  beforeEach(() => { process.env.MCP_USER_ID = 'tester'; });
  afterEach(() => { delete process.env.MCP_USER_ID; });

  it('registers all account routes', () => {
    const { server, tools } = makeServer();
    accountTools(server as any, makeDb() as any, makeImap() as any);
    expect([...tools.keys()].sort()).toEqual([
      'imap_add_account',
      'imap_add_account_auto',
      'imap_add_account_with_provider',
      'imap_connect',
      'imap_disconnect',
      'imap_get_outbox_dir',
      'imap_list_accounts',
      'imap_list_providers',
      'imap_remove_account',
      'imap_test_account',
    ]);
  });

  it('imap_add_account stores account and reports SMTP disabled by default', async () => {
    const db = makeDb();
    const { server, tools } = makeServer();
    accountTools(server as any, db as any, makeImap() as any);
    const out = await invoke(tools, 'imap_add_account', { name: 'Work', host: 'h', port: 993, user: 'me', password: 'p', tls: true });
    expect(out.success).toBe(true);
    expect(out.accountId).toBe('acc-1');
    expect(out.smtp).toEqual({ enabled: false });
    expect(db.created[0]).toMatchObject({ user_id: 'u1', name: 'Work', host: 'h', username: 'me', smtp_host: undefined });
  });

  it('imap_add_account enables SMTP and defaults smtp user/pass to IMAP creds', async () => {
    const db = makeDb();
    const { server, tools } = makeServer();
    accountTools(server as any, db as any, makeImap() as any);
    const out = await invoke(tools, 'imap_add_account', { name: 'W', host: 'h', port: 993, user: 'me', password: 'p', tls: true, smtpHost: 'smtp.h' });
    expect(out.smtp).toEqual({ enabled: true, host: 'smtp.h', port: 587, secure: false });
    expect(db.created[0]).toMatchObject({ smtp_host: 'smtp.h', smtp_username: 'me', smtp_password: 'p' });
  });

  it('imap_list_accounts maps stored accounts for the user', async () => {
    const { server, tools } = makeServer();
    accountTools(server as any, makeDb() as any, makeImap() as any);
    const out = await invoke(tools, 'imap_list_accounts', {});
    expect(out.user).toBe('tester');
    expect(out.accounts).toEqual([{ id: 'acc-1', name: 'Work', host: 'imap.example.com', port: 993, user: 'me', tls: true }]);
  });

  it('imap_remove_account / disconnect return confirmations', async () => {
    const { server, tools } = makeServer();
    accountTools(server as any, makeDb() as any, makeImap() as any);
    expect(await invoke(tools, 'imap_remove_account', { accountId: 'acc-1' }))
      .toEqual({ success: true, message: 'Account acc-1 removed successfully' });
    expect(await invoke(tools, 'imap_disconnect', { accountId: 'acc-1' }))
      .toEqual({ success: true, message: 'Disconnected from account acc-1' });
  });

  it('imap_connect connects a known account and errors on a missing one', async () => {
    const { server, tools } = makeServer();
    accountTools(server as any, makeDb() as any, makeImap() as any);
    const ok = await invoke(tools, 'imap_connect', { accountId: 'acc-1' });
    expect(ok).toMatchObject({ success: true, accountId: 'acc-1' });
    const err = await invoke(tools, 'imap_connect', { accountId: 'missing' });
    expect(JSON.stringify(err)).toContain('missing');
  });

  it('imap_list_providers returns the preset catalog', async () => {
    const { server, tools } = makeServer();
    accountTools(server as any, makeDb() as any, makeImap() as any);
    const out = await invoke(tools, 'imap_list_providers', {});
    expect(out.success).toBe(true);
    expect(out.count).toBeGreaterThan(0);
    expect(out.providers.find((p: any) => p.id === 'gmail')).toBeTruthy();
  });

  it('imap_add_account_with_provider fills IMAP/SMTP from the preset', async () => {
    const db = makeDb();
    const { server, tools } = makeServer();
    accountTools(server as any, db as any, makeImap() as any);
    const out = await invoke(tools, 'imap_add_account_with_provider', { providerId: 'gmail', name: 'G', email: 'me@gmail.com', password: 'app-pw', smtpEnabled: true });
    expect(out.success).toBe(true);
    expect(out.settings.imap).toEqual({ host: 'imap.gmail.com', port: 993, security: 'SSL' });
    expect(out.settings.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, security: 'SSL' });
    expect(db.created[0]).toMatchObject({ host: 'imap.gmail.com', port: 993, tls: true, smtp_host: 'smtp.gmail.com', smtp_username: 'me@gmail.com' });
  });

  it('imap_add_account_with_provider uses imapUsername override and rejects unknown providers', async () => {
    const db = makeDb();
    const { server, tools } = makeServer();
    accountTools(server as any, db as any, makeImap() as any);
    await invoke(tools, 'imap_add_account_with_provider', { providerId: 'gmail', name: 'G', email: 'me@gmail.com', password: 'p', smtpEnabled: false, imapUsername: 'DOMAIN\\me' });
    expect(db.created[0].username).toBe('DOMAIN\\me');
    const err = await invoke(tools, 'imap_add_account_with_provider', { providerId: 'nope', name: 'G', email: 'x@y.com', password: 'p', smtpEnabled: false });
    expect(JSON.stringify(err)).toContain('Unknown provider');
  });

  it('imap_add_account_auto detects provider by domain and errors when unknown', async () => {
    const db = makeDb();
    const { server, tools } = makeServer();
    accountTools(server as any, db as any, makeImap() as any);
    const out = await invoke(tools, 'imap_add_account_auto', { name: 'G', email: 'me@gmail.com', password: 'p', smtpEnabled: false });
    expect(out.autoDetected).toBe(true);
    expect(out.settings.imap.host).toBe('imap.gmail.com');
    const err = await invoke(tools, 'imap_add_account_auto', { name: 'G', email: 'me@no-such-domain-xyz.example', password: 'p', smtpEnabled: false });
    expect(JSON.stringify(err)).toContain('auto-detect');
  });

  it('imap_test_account handles found / not-found / not-owned', async () => {
    const { server, tools } = makeServer();
    accountTools(server as any, makeDb() as any, makeImap() as any);
    expect(await invoke(tools, 'imap_test_account', { accountId: 'acc-1' })).toMatchObject({ success: true, folderCount: 5, inboxMessageCount: 3 });
    expect(await invoke(tools, 'imap_test_account', { accountId: 'missing' })).toMatchObject({ success: false, result: 'account_not_found' });

    const otherDb = makeDb({ getDecryptedAccount: (id: string) => ({ account_id: id, user_id: 'someone-else', name: 'X', host: 'h', port: 993, username: 'u', password: 'p', tls: true }) });
    const s2 = makeServer();
    accountTools(s2.server as any, otherDb as any, makeImap() as any);
    expect(await invoke(s2.tools, 'imap_test_account', { accountId: 'acc-1' })).toMatchObject({ success: false, result: 'account_not_owned_by_caller' });
  });
});
