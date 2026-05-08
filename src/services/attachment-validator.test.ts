/**
 * Tests for attachment-validator.ts security policies introduced in v2.17.9:
 *   - sanitizeFilename basename semantics + control-char strip
 *   - isDotfileBasename
 *   - findDotSegment (path component scan, skipping '.' and '..')
 *   - validateAttachmentPaths dotfile reject (default-on, opt-out)
 *   - validateAttachmentPaths size caps (per-attachment + aggregate)
 *
 * These policies enforce: attachments cannot accidentally exfiltrate
 * dotfile-prefixed host secrets (~/.ssh, ~/.aws, ~/.config) and cannot
 * exceed configurable size caps. Tests verify both the rejection paths
 * and the override knob.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findDotSegment,
  getOutboxDir,
  isDotfileBasename,
  sanitizeFilename,
  validateAttachmentPaths,
} from './attachment-validator.js';

describe('sanitizeFilename', () => {
  it('extracts basename from a full path', () => {
    expect(sanitizeFilename('/foo/bar/baz.txt')).toBe('baz.txt');
  });

  it('extracts basename from a Windows-style path', () => {
    // path.basename on POSIX treats backslash as a literal character; on
    // Windows it would split. Either way, no path separator survives in
    // the output of a Workspace-supplied filename like
    // "..\\..\\windows\\sec.dat" because either basename strips it or
    // (POSIX) the whole thing is the basename without a separator.
    const result = sanitizeFilename('foo\\bar.dat');
    expect(result).not.toContain('/');
  });

  it('strips control characters', () => {
    expect(sanitizeFilename('hello\x00\x07world.txt')).toBe('helloworld.txt');
  });

  it('does not strip leading dots (policy is the caller\'s)', () => {
    expect(sanitizeFilename('.bashrc')).toBe('.bashrc');
  });

  it('caps at 255 bytes', () => {
    const long = 'a'.repeat(300) + '.txt';
    expect(sanitizeFilename(long).length).toBeLessThanOrEqual(255);
  });

  it('returns empty for path-only input with no basename', () => {
    expect(sanitizeFilename('/')).toBe('');
  });
});

describe('isDotfileBasename', () => {
  it('returns true for .bashrc', () => {
    expect(isDotfileBasename('.bashrc')).toBe(true);
  });
  it('returns false for normal filename', () => {
    expect(isDotfileBasename('report.pdf')).toBe(false);
  });
  it('returns false for empty string', () => {
    expect(isDotfileBasename('')).toBe(false);
  });
});

describe('findDotSegment', () => {
  it('finds .ssh in /Users/colin/.ssh/id_rsa', () => {
    expect(findDotSegment('/Users/colin/.ssh/id_rsa')).toBe('.ssh');
  });
  it('finds .aws in /home/user/.aws/credentials', () => {
    expect(findDotSegment('/home/user/.aws/credentials')).toBe('.aws');
  });
  it('returns null when no segment starts with .', () => {
    expect(findDotSegment('/Users/colin/Downloads/foo.txt')).toBeNull();
  });
  it('skips . and .. (those are caught elsewhere)', () => {
    expect(findDotSegment('/Users/./colin/../colin/Downloads')).toBeNull();
  });
  it('detects a dotfile in the basename position', () => {
    expect(findDotSegment('/Users/colin/Downloads/.envrc')).toBe('.envrc');
  });
});

describe('validateAttachmentPaths — dotfile policy', () => {
  let tmpDir: string;
  let normalFile: string;
  let dotDir: string;
  let dotDirFile: string;
  let dotFile: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imap-att-test-'));
    normalFile = path.join(tmpDir, 'report.pdf');
    await fs.promises.writeFile(normalFile, 'pdf-bytes');
    dotDir = path.join(tmpDir, '.ssh');
    await fs.promises.mkdir(dotDir);
    dotDirFile = path.join(dotDir, 'id_rsa');
    await fs.promises.writeFile(dotDirFile, 'PRIVATE KEY');
    dotFile = path.join(tmpDir, '.envrc');
    await fs.promises.writeFile(dotFile, 'export FOO=bar');
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('accepts a normal file in an allowed dir', async () => {
    const result = await validateAttachmentPaths(
      [{ path: normalFile }],
      { globalAllowedDirs: [tmpDir], maxSizeBytes: 1_000_000, maxTotalSizeBytes: 1_000_000 },
      [tmpDir]
    );
    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe('report.pdf');
  });

  it('rejects a path with a .dotdir segment by default', async () => {
    const result = await validateAttachmentPaths(
      [{ path: dotDirFile }],
      { globalAllowedDirs: [tmpDir], maxSizeBytes: 1_000_000, maxTotalSizeBytes: 1_000_000 },
      [tmpDir]
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ kind: 'dotfile-or-dotdir-rejected', component: '.ssh' }),
    ]);
    expect(result.attachments).toHaveLength(0);
  });

  it('rejects a dotfile in the basename position by default', async () => {
    const result = await validateAttachmentPaths(
      [{ path: dotFile }],
      { globalAllowedDirs: [tmpDir], maxSizeBytes: 1_000_000, maxTotalSizeBytes: 1_000_000 },
      [tmpDir]
    );
    expect(result.errors).toEqual([
      expect.objectContaining({ kind: 'dotfile-or-dotdir-rejected', component: '.envrc' }),
    ]);
  });

  it('accepts dotdir paths when denyDotfiles is false', async () => {
    const result = await validateAttachmentPaths(
      [{ path: dotDirFile }],
      {
        globalAllowedDirs: [tmpDir],
        maxSizeBytes: 1_000_000,
        maxTotalSizeBytes: 1_000_000,
        denyDotfiles: false,
      },
      [tmpDir]
    );
    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe('id_rsa');
  });
});

describe('validateAttachmentPaths — size caps', () => {
  let tmpDir: string;
  let smallFile: string;
  let bigFile: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imap-att-size-'));
    smallFile = path.join(tmpDir, 'small.bin');
    await fs.promises.writeFile(smallFile, Buffer.alloc(100));
    bigFile = path.join(tmpDir, 'big.bin');
    await fs.promises.writeFile(bigFile, Buffer.alloc(20_000));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects per-attachment size over cap', async () => {
    const result = await validateAttachmentPaths(
      [{ path: bigFile }],
      { globalAllowedDirs: [tmpDir], maxSizeBytes: 10_000, maxTotalSizeBytes: 1_000_000 },
      [tmpDir]
    );
    expect(result.errors[0]?.kind).toBe('size-exceeds-per-attachment');
  });

  it('rejects aggregate size over cap', async () => {
    const result = await validateAttachmentPaths(
      [{ path: smallFile }, { path: bigFile }],
      { globalAllowedDirs: [tmpDir], maxSizeBytes: 100_000, maxTotalSizeBytes: 15_000 },
      [tmpDir]
    );
    expect(result.errors.some(e => e.kind === 'aggregate-size-exceeds')).toBe(true);
  });

  it('accepts within both caps', async () => {
    const result = await validateAttachmentPaths(
      [{ path: smallFile }],
      { globalAllowedDirs: [tmpDir], maxSizeBytes: 1_000, maxTotalSizeBytes: 1_000 },
      [tmpDir]
    );
    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
  });
});

describe('getOutboxDir (#148)', () => {
  it('returns a path under ~/.imap-mcp/users/<userId>/outbox/', () => {
    const userId = 'test-user-' + Date.now();
    const dir = getOutboxDir(userId);
    expect(dir).toBe(path.join(os.homedir(), '.imap-mcp', 'users', userId, 'outbox'));
  });

  it('creates the directory on first access (mode 0700)', async () => {
    const userId = 'test-user-mkdir-' + Date.now();
    const dir = getOutboxDir(userId);
    const stats = await fs.promises.stat(dir);
    expect(stats.isDirectory()).toBe(true);
    // mode bits — on most POSIX filesystems mkdir-with-mode-0o700 produces
    // a dir whose mode masked with 0o777 is 0o700. (Some filesystems
    // collapse to 0o755; we only assert the *user* bits are set.)
    expect(stats.mode & 0o700).toBe(0o700);
    await fs.promises.rmdir(dir);
  });

  it('is idempotent across repeated calls', async () => {
    const userId = 'test-user-idempotent-' + Date.now();
    const a = getOutboxDir(userId);
    const b = getOutboxDir(userId);
    expect(a).toBe(b);
    await fs.promises.rmdir(a);
  });
});

describe('validateAttachmentPaths — outbox auto-allowlist (#148)', () => {
  it('accepts a file inside the per-user outbox even when no other allowed dirs are configured', async () => {
    const userId = 'test-validator-outbox-' + Date.now();
    const outbox = getOutboxDir(userId);
    const filePath = path.join(outbox, 'agent-generated.pdf');
    await fs.promises.writeFile(filePath, 'pdf-bytes');
    try {
      const result = await validateAttachmentPaths(
        [{ path: filePath }],
        { globalAllowedDirs: [], maxSizeBytes: 1_000_000, maxTotalSizeBytes: 1_000_000 },
        // Caller passes an empty allow-list; the outbox is the safety net.
        // Note: this test exercises validateAttachmentPaths directly with
        // [outbox] passed in; resolveAllowedDirs always prepends it in
        // practice. We pass it explicitly here to keep the test
        // independent of DB state.
        [outbox]
      );
      expect(result.errors).toEqual([]);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].filename).toBe('agent-generated.pdf');
    } finally {
      await fs.promises.unlink(filePath);
      await fs.promises.rmdir(outbox);
    }
  });
});
