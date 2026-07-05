// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for resolveExportDest — the destPath guard for direct exports (#270).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveExportDest, allowedExportRoots } from './export-dest-resolver.js';

describe('resolveExportDest', () => {
  let root: string;
  const prevEnv = process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS;

  beforeEach(() => {
    // Use a real temp dir as the allow-listed root so tests never touch $HOME.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-dest-'));
    process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS = root;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS;
    else process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS = prevEnv;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('creates and returns a dir within an allowed root', () => {
    const dest = path.join(root, 'sent-mail');
    const out = resolveExportDest(dest);
    expect(out).toBe(path.resolve(dest));
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).isDirectory()).toBe(true);
  });

  it('rejects a relative path', () => {
    expect(() => resolveExportDest('relative/dir')).toThrow(/absolute/i);
  });

  it('rejects a path outside every allowed root', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
    try {
      expect(() => resolveExportDest(path.join(other, 'x'))).toThrow(/not within an allowed export root/i);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects the MCP data dir even when it is under an allowed root', () => {
    // Allow-list home so ~/.imap-mcp passes the root check but fails the MCP guard.
    process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS = os.homedir();
    const mcp = path.join(os.homedir(), '.imap-mcp', 'users', 'u', 'outbox', 'x');
    expect(() => resolveExportDest(mcp)).toThrow(/outside the MCP data dir/i);
  });

  it('rejects the bare home root', () => {
    process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS = os.homedir();
    expect(() => resolveExportDest(os.homedir())).toThrow(/subdirectory/i);
  });

  it('rejects a top-level hidden dir under home', () => {
    process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS = os.homedir();
    expect(() => resolveExportDest(path.join(os.homedir(), '.ssh'))).toThrow(/hidden \(dot\) directory/i);
  });

  it('rejects a symlink that escapes the allowed root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'escape-'));
    const link = path.join(root, 'link');
    try {
      fs.symlinkSync(outside, link);
      expect(() => resolveExportDest(path.join(link, 'sub'))).toThrow(/symlink/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('defaults the allow-list to the home directory', () => {
    delete process.env.IMAP_MCP_ALLOWED_EXPORT_DIRS;
    expect(allowedExportRoots()).toEqual([os.homedir()]);
  });
});
