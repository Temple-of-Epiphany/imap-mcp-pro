// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for imap_server_reload (#84).

import { describe, expect, it, beforeEach } from 'vitest';
import { adminTools } from './admin-tools.js';

type Registered = { spec: any; handler: any };

function makeServer() {
  const tools = new Map<string, Registered>();
  const server = { registerTool: (name: string, spec: any, handler: any) => tools.set(name, { spec, handler }) };
  return { server, tools };
}

async function invoke(tools: Map<string, Registered>, name: string, args: any) {
  return JSON.parse((await tools.get(name)!.handler(args)).content[0].text);
}

function makeImap() {
  const calls = { disconnectAll: 0, clearCaps: 0 };
  return {
    calls,
    disconnectAll: async () => { calls.disconnectAll++; return 3; },
    clearCapabilitiesCache: () => { calls.clearCaps++; return 2; },
  };
}

function makeSmtp() {
  const calls = { disconnectAll: 0 };
  return {
    calls,
    getPoolStats: () => ({ configured: 4 }),
    disconnectAll: () => { calls.disconnectAll++; },
  };
}

function register(imap: any, smtp: any) {
  const { server, tools } = makeServer();
  adminTools(server as any, imap as any, smtp as any);
  return tools;
}

describe('imap_server_reload (#84)', () => {
  let imap: any, smtp: any, tools: Map<string, Registered>;
  beforeEach(() => { imap = makeImap(); smtp = makeSmtp(); tools = register(imap, smtp); });

  it('registers the tool', () => {
    expect(tools.has('imap_server_reload')).toBe(true);
  });

  it('resets everything by default and reports counts', async () => {
    const out = await invoke(tools, 'imap_server_reload', {});
    expect(out.success).toBe(true);
    expect(out.reset).toEqual({ imapConnectionsClosed: 3, smtpConnectionsClosed: 4, capabilitiesCacheCleared: 2 });
    expect(out.actions).toEqual(['imap-pool', 'smtp-pool', 'capabilities-cache']);
    expect(imap.calls).toEqual({ disconnectAll: 1, clearCaps: 1 });
    expect(smtp.calls.disconnectAll).toBe(1);
    expect(out.note).toMatch(/restart/i);
  });

  it('skips the IMAP pool when disconnectImap is false', async () => {
    const out = await invoke(tools, 'imap_server_reload', { disconnectImap: false });
    expect(imap.calls.disconnectAll).toBe(0);
    expect(out.reset.imapConnectionsClosed).toBe(0);
    expect(out.actions).not.toContain('imap-pool');
    // others still run
    expect(smtp.calls.disconnectAll).toBe(1);
    expect(out.reset.capabilitiesCacheCleared).toBe(2);
  });

  it('can clear only the capabilities cache', async () => {
    const out = await invoke(tools, 'imap_server_reload', { disconnectImap: false, disconnectSmtp: false });
    expect(out.actions).toEqual(['capabilities-cache']);
    expect(out.reset).toEqual({ imapConnectionsClosed: 0, smtpConnectionsClosed: 0, capabilitiesCacheCleared: 2 });
  });
});
