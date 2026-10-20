// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tool profile (#293): `core` must register exactly CORE_TOOLS, `full` must
// register everything, and every name in CORE_TOOLS must be a real tool so a
// typo in the list cannot silently hide an everyday tool.

import { describe, expect, it } from 'vitest';
import { registerTools } from './index.js';
import {
  CORE_TOOLS,
  getActiveToolProfile,
  isToolVisible,
  resolveToolProfile,
} from './tool-profile.js';

function registerWithProfile(profile: 'full' | 'core'): Set<string> {
  const names = new Set<string>();
  // Registration only stores specs/handlers; services are never invoked, so
  // empty stubs are sufficient (same pattern as rfc9051-compliance.test.ts).
  const server: any = { registerTool: (name: string) => { names.add(name); return {}; } };
  const stub: any = {};
  registerTools(
    server, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub,
    { toolProfile: profile }
  );
  return names;
}

describe('resolveToolProfile', () => {
  it('defaults to full when unset or blank', () => {
    expect(resolveToolProfile(undefined)).toBe('full');
    expect(resolveToolProfile('')).toBe('full');
    expect(resolveToolProfile('   ')).toBe('full');
  });

  it('accepts known profiles case-insensitively', () => {
    expect(resolveToolProfile('core')).toBe('core');
    expect(resolveToolProfile(' CORE ')).toBe('core');
    expect(resolveToolProfile('Full')).toBe('full');
  });

  it('falls back to full and warns on an unknown value', () => {
    const warnings: string[] = [];
    expect(resolveToolProfile('minimal', (m) => warnings.push(m))).toBe('full');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('minimal');
  });
});

describe('isToolVisible', () => {
  it('shows everything under full', () => {
    expect(isToolVisible('imap_anything_at_all', 'full')).toBe(true);
  });
  it('shows only CORE_TOOLS under core', () => {
    expect(isToolVisible('imap_search_emails', 'core')).toBe(true);
    expect(isToolVisible('imap_test_quad9_dns', 'core')).toBe(false);
  });
});

describe('registerTools with a tool profile', () => {
  const full = registerWithProfile('full');

  it('full registers the whole catalog and hides nothing', () => {
    expect(full.size).toBeGreaterThan(100);
    const state = getActiveToolProfile();
    expect(state.profile).toBe('full');
    expect(state.hidden).toEqual([]);
    expect(state.registered.length).toBe(full.size);
  });

  it('every CORE_TOOLS entry is a tool that exists in the full catalog', () => {
    for (const name of CORE_TOOLS) {
      expect(full.has(name), `${name} is listed in CORE_TOOLS but no tool registers it`).toBe(true);
    }
  });

  it('core registers exactly CORE_TOOLS and reports the rest as hidden', () => {
    const core = registerWithProfile('core');
    expect([...core].sort()).toEqual([...CORE_TOOLS].sort());

    const state = getActiveToolProfile();
    expect(state.profile).toBe('core');
    expect(state.registered.length).toBe(core.size);
    expect(state.hidden.length).toBe(full.size - core.size);
    expect(new Set([...state.hidden, ...state.registered])).toEqual(full);
  });

  it('core keeps the discovery tools so a session can see what is hidden', () => {
    const core = registerWithProfile('core');
    expect(core.has('imap_list_tools')).toBe(true);
    expect(core.has('imap_help')).toBe(true);
    expect(core.has('imap_about')).toBe(true);
  });

  it('core stays a small surface (target 25–30 tools)', () => {
    expect(CORE_TOOLS.size).toBeGreaterThanOrEqual(20);
    expect(CORE_TOOLS.size).toBeLessThanOrEqual(35);
  });
});
