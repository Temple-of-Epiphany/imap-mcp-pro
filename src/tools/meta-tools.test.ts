// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for imap_help (#39) and imap_about accuracy.

import { describe, expect, it, beforeEach } from 'vitest';
import { metaTools } from './meta-tools.js';

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
