// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for imap_help (#39) and imap_about accuracy.

import { describe, expect, it, beforeEach } from 'vitest';
import { metaTools } from './meta-tools.js';
import { registerTools } from './index.js';
import { getToolCatalog, categoryFor } from './tool-catalog.js';

type Registered = { spec: any; handler: any };

function makeServer() {
  const tools = new Map<string, Registered>();
  const server = { registerTool: (name: string, spec: any, handler: any) => tools.set(name, { spec, handler }) };
  return { server, tools };
}

async function text(tools: Map<string, Registered>, name: string, args: any = {}) {
  return (await tools.get(name)!.handler(args)).content[0].text;
}

describe('metaTools', () => {
  let tools: Map<string, Registered>;
  beforeEach(() => { const s = makeServer(); metaTools(s.server as any); tools = s.tools; });

  it('registers imap_help', () => {
    expect(tools.has('imap_help')).toBe(true);
  });

  it('imap_help defaults to the overview with the topic list', async () => {
    const out = await text(tools, 'imap_help');
    expect(out).toMatch(/IMAP MCP Pro/);
    expect(out).toMatch(/getting-started/);
    expect(out).toMatch(/imap_list_tools/); // points at the exhaustive list
  });

  it('imap_help returns category-specific content', async () => {
    const cleanup = await text(tools, 'imap_help', { category: 'cleanup' });
    expect(cleanup).toMatch(/imap_get_largest_emails/);
    expect(cleanup).toMatch(/imap_get_quota/);

    const sending = await text(tools, 'imap_help', { category: 'sending' });
    expect(sending).toMatch(/imap_send_email/);
    expect(sending).not.toMatch(/imap_get_largest_emails/);
  });

  it('imap_help falls back to overview for an unknown category', async () => {
    // The schema enum guards inputs, but the handler is defensive too.
    const out = await text(tools, 'imap_help', { category: 'nope' as any });
    expect(out).toMatch(/IMAP MCP Pro — Help/);
  });

  it('imap_about reports the current PolyForm license (not the stale dual-license string)', async () => {
    const about = JSON.parse(await text(tools, 'imap_about'));
    expect(about.license.model).toMatch(/PolyForm Noncommercial/);
    expect(JSON.stringify(about)).not.toMatch(/CleanTalk/);
  });
});


// ---------------------------------------------------------------------------
// #302 — imap_list_tools is generated from the live registry
// ---------------------------------------------------------------------------
describe('imap_list_tools from the registry (#302)', () => {
  function registerAll(profile: 'full' | 'core') {
    const { server, tools } = makeServer();
    const stub: any = {};
    registerTools(server as any, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, { toolProfile: profile });
    return tools;
  }

  it('lists exactly the tools that were registered (full profile)', async () => {
    const tools = registerAll('full');
    const body = JSON.parse(await text(tools, 'imap_list_tools'));
    expect(body.totalTools).toBe(tools.size);
    expect(body.totalTools).toBeGreaterThan(100);
    expect(new Set(body.tools.map((t: any) => t.name))).toEqual(new Set(tools.keys()));
    expect(body.toolProfile.active).toBe('full');
  });

  it('tracks the core profile: 29 tools listed, the rest reported hidden', async () => {
    const tools = registerAll('core');
    const body = JSON.parse(await text(tools, 'imap_list_tools'));
    expect(body.totalTools).toBe(tools.size);
    expect(body.toolProfile.hiddenCount).toBeGreaterThan(90);
    expect(body.tools.some((t: any) => t.name === 'imap_test_quad9_dns')).toBe(false);
  });

  it('carries title, description, parameters and hints for every tool, and no tool lands in "other"', async () => {
    const tools = registerAll('full');
    const body = JSON.parse(await text(tools, 'imap_list_tools'));
    for (const t of body.tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.description, t.name).toBeTruthy();
      expect(Array.isArray(t.parameters), t.name).toBe(true);
      expect(typeof t.readOnly).toBe('boolean');
    }
    const other = body.tools.filter((t: any) => t.category === 'other').map((t: any) => t.name);
    expect(other, 'tools missing from TOOL_CATEGORIES').toEqual([]);
    const search = body.tools.find((t: any) => t.name === 'imap_search_emails');
    expect(search.parameters).toContain('accountId');
  });

  it('filters by category slug and warns on an unknown one', async () => {
    const tools = registerAll('full');
    const dns = JSON.parse(await text(tools, 'imap_list_tools', { category: 'dns' }));
    expect(dns.filteredCount).toBe(dns.tools.length);
    expect(dns.tools.every((t: any) => t.category === 'dns')).toBe(true);
    expect(dns.tools.map((t: any) => t.name)).toContain('imap_test_quad9_dns');
    const bad = JSON.parse(await text(tools, 'imap_list_tools', { category: 'nope' }));
    expect(bad.warning).toMatch(/Unknown category/);
    expect(bad.filteredCount).toBe(bad.totalTools);
    expect(getToolCatalog().length).toBe(bad.totalTools);
    expect(categoryFor('imap_send_email').slug).toBe('email');
  });
});
