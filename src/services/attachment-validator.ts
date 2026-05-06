/**
 * AttachmentValidator — path-based attachment validation
 *
 * WP1 (Issue #100): allow imap_send_email to accept absolute file paths
 * via attachmentPaths. Each path is validated against:
 *   - Allowed directories (per-user override > global config > none)
 *   - Symlink resolution (must resolve inside an allowed dir)
 *   - Absolute path requirement
 *   - No `..` segments before resolution
 *   - File exists, is regular, is readable
 *   - Per-attachment size cap (cheap stat first, before any content I/O)
 *   - Aggregate size cap across all attachments in one send
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-30
 * Version: 0.1.0
 *
 * Tracker: #97. Issue: #100 (WP1).
 */

import fs from 'fs';
import path from 'path';
import { lookup as mimeLookup } from 'mime-types';
import { DatabaseService } from './database-service.js';

export interface ValidatorConfig {
  /** Global allowed dirs from ServerConfig (already absolute paths). */
  globalAllowedDirs: string[];
  /** Per-attachment max bytes. */
  maxSizeBytes: number;
  /** Aggregate max bytes for one send. */
  maxTotalSizeBytes: number;
  /**
   * When true (default) reject any path with a segment starting with '.'
   * (dotfiles/dotdirs like .ssh, .aws, .config) and any inline filename
   * starting with '.'. Set false via IMAP_MCP_ALLOW_DOTFILES=true to opt
   * back in. Reason: dotfile paths are overwhelmingly OS/app secrets
   * (~/.ssh/id_rsa, ~/.aws/credentials, ~/.config/...) that should never
   * leave the host as an email attachment.
   */
  denyDotfiles?: boolean;
}

export interface ValidatedAttachment {
  /** The original input path (before symlink resolution). */
  inputPath: string;
  /** The resolved real path (after fs.realpath). */
  realPath: string;
  /** Sanitized basename used as the attachment filename. */
  filename: string;
  /** Detected (or overridden) Content-Type. */
  contentType: string;
  /** File size in bytes (from stat). */
  sizeBytes: number;
}

export type ValidationFailure =
  | { kind: 'not-absolute'; path: string }
  | { kind: 'parent-traversal'; path: string }
  | { kind: 'not-found'; path: string }
  | { kind: 'not-regular-file'; path: string }
  | { kind: 'not-readable'; path: string }
  | { kind: 'outside-allowed-dirs'; path: string; resolved: string }
  | { kind: 'size-exceeds-per-attachment'; path: string; sizeBytes: number; limitBytes: number }
  | { kind: 'aggregate-size-exceeds'; pendingPath: string; totalBytes: number; limitBytes: number }
  | { kind: 'no-allowed-dirs-configured' }
  | { kind: 'dotfile-or-dotdir-rejected'; path: string; component: string }
  | { kind: 'invalid-filename'; raw: string };

export interface ValidationResult {
  attachments: ValidatedAttachment[];
  errors: ValidationFailure[];
}

/**
 * Resolve the per-user allowed dirs (CSV) plus the global ones.
 * User column wins when present (could be the empty string to opt out).
 */
export function resolveAllowedDirs(
  db: DatabaseService,
  userId: string,
  globalDirs: string[]
): string[] {
  let raw: string | null = null;
  try {
    const row = db.getDb()
      .prepare('SELECT allowed_attachment_dirs FROM users WHERE user_id = ?')
      .get(userId) as { allowed_attachment_dirs: string | null } | undefined;
    raw = row?.allowed_attachment_dirs ?? null;
  } catch {
    // Column may not exist (pre-1.9.0 schema) — fall through to globals.
    raw = null;
  }
  if (raw === null) return globalDirs;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Strip any path component from a filename and clean it for use in a MIME
 * Content-Disposition header (RFC 2183).
 *
 *   "/foo/bar/baz.txt"        -> "baz.txt"
 *   "..\\..\\windows\\sec.dat" -> "sec.dat"
 *   "report\x00.pdf"         -> "report.pdf"
 *
 * Leading dots are NOT stripped here — that is a policy decision exposed
 * via the `denyDotfiles` config knob, so callers can choose to allow
 * legitimate dotfile sends while the default rejects them outright.
 *
 * Returns an empty string if the input has no usable basename (e.g. "/"
 * or "..."). Callers should treat empty as a validation failure.
 */
export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename);
  const noCtl = base.replace(/[\x00-\x1f\x7f]/g, '');
  return noCtl.slice(0, 255);
}

/**
 * Returns true when the basename indicates a dotfile (e.g. ".bashrc",
 * "..hidden"). Distinct from path-component scanning: this only inspects
 * a single sanitized filename string.
 */
export function isDotfileBasename(filename: string): boolean {
  return filename.length > 0 && filename.startsWith('.');
}

/**
 * Returns the first dot-prefixed segment of an absolute path, or null if
 * none. Skips '.' and '..' (those are caught by the parent-traversal /
 * realpath checks). Only the segments between separators are considered;
 * symbolic-link resolution is the caller's responsibility (validate both
 * the input path and the realpath).
 */
export function findDotSegment(absolutePath: string): string | null {
  const segments = absolutePath.split(path.sep).filter(Boolean);
  for (const s of segments) {
    if (s === '.' || s === '..') continue;
    if (s.startsWith('.')) return s;
  }
  return null;
}

/** True if `child` (after realpath) is inside `parent` (after realpath). */
function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  return c.startsWith(p + path.sep);
}

export interface ValidateInput {
  path: string;
  /** Optional override of detected Content-Type. */
  contentType?: string;
  /** Optional override of basename. */
  filename?: string;
}

/**
 * Validate an array of attachment paths in one shot. Returns a successful
 * validation only when every path passed AND the aggregate size is under
 * the cap. Otherwise returns the failures so the caller can surface them.
 */
export async function validateAttachmentPaths(
  inputs: ValidateInput[],
  config: ValidatorConfig,
  allowedDirs: string[]
): Promise<ValidationResult> {
  const errors: ValidationFailure[] = [];
  const attachments: ValidatedAttachment[] = [];

  if (allowedDirs.length === 0) {
    errors.push({ kind: 'no-allowed-dirs-configured' });
    return { attachments, errors };
  }

  // Pre-resolve the allowed dirs once (handles symlinks in the dir entries).
  const resolvedAllowed: string[] = [];
  for (const d of allowedDirs) {
    if (!path.isAbsolute(d)) continue;
    try {
      resolvedAllowed.push(await fs.promises.realpath(d));
    } catch {
      // Drop unreadable / non-existent entries silently — they can't match.
    }
  }
  if (resolvedAllowed.length === 0) {
    errors.push({ kind: 'no-allowed-dirs-configured' });
    return { attachments, errors };
  }

  let runningTotal = 0;

  for (const input of inputs) {
    const p = input.path;

    if (!path.isAbsolute(p)) {
      errors.push({ kind: 'not-absolute', path: p });
      continue;
    }
    // Reject `..` segments BEFORE resolution to avoid accidentally
    // climbing out of an allowed dir via a symlink trick.
    if (p.split(path.sep).includes('..')) {
      errors.push({ kind: 'parent-traversal', path: p });
      continue;
    }

    // Dotfile / dotdir reject (default-on). Scan the input path; we re-scan
    // the realpath below in case a non-dotted symlink resolves into a dotted
    // directory.
    const denyDot = config.denyDotfiles !== false;
    if (denyDot) {
      const seg = findDotSegment(p);
      if (seg) {
        errors.push({ kind: 'dotfile-or-dotdir-rejected', path: p, component: seg });
        continue;
      }
    }

    let realPath: string;
    try {
      realPath = await fs.promises.realpath(p);
    } catch {
      errors.push({ kind: 'not-found', path: p });
      continue;
    }

    // Re-scan after realpath to catch symlinks into dotdirs.
    if (denyDot) {
      const seg = findDotSegment(realPath);
      if (seg) {
        errors.push({ kind: 'dotfile-or-dotdir-rejected', path: p, component: seg });
        continue;
      }
    }

    // Containment check after realpath.
    const inside = resolvedAllowed.some((dir) => isInside(realPath, dir));
    if (!inside) {
      errors.push({ kind: 'outside-allowed-dirs', path: p, resolved: realPath });
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(realPath);
    } catch {
      errors.push({ kind: 'not-found', path: p });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({ kind: 'not-regular-file', path: p });
      continue;
    }
    try {
      await fs.promises.access(realPath, fs.constants.R_OK);
    } catch {
      errors.push({ kind: 'not-readable', path: p });
      continue;
    }
    if (stat.size > config.maxSizeBytes) {
      errors.push({
        kind: 'size-exceeds-per-attachment',
        path: p,
        sizeBytes: stat.size,
        limitBytes: config.maxSizeBytes,
      });
      continue;
    }
    if (runningTotal + stat.size > config.maxTotalSizeBytes) {
      errors.push({
        kind: 'aggregate-size-exceeds',
        pendingPath: p,
        totalBytes: runningTotal + stat.size,
        limitBytes: config.maxTotalSizeBytes,
      });
      continue;
    }
    runningTotal += stat.size;

    const baseName = path.basename(realPath);
    const filename = sanitizeFilename(input.filename ?? baseName);
    if (filename.length === 0) {
      errors.push({ kind: 'invalid-filename', raw: input.filename ?? baseName });
      continue;
    }
    if (config.denyDotfiles !== false && isDotfileBasename(filename)) {
      errors.push({ kind: 'dotfile-or-dotdir-rejected', path: p, component: filename });
      continue;
    }
    const contentType =
      input.contentType ??
      (mimeLookup(realPath) || 'application/octet-stream');

    attachments.push({
      inputPath: p,
      realPath,
      filename,
      contentType,
      sizeBytes: stat.size,
    });
  }

  return { attachments, errors };
}

/**
 * Convenience helper: render a validation-failure list as a human-readable
 * string for the structured tool error response.
 */
export function formatValidationErrors(errors: ValidationFailure[]): string[] {
  return errors.map((e) => {
    switch (e.kind) {
      case 'not-absolute':              return `Path is not absolute: ${e.path}`;
      case 'parent-traversal':          return `Path contains '..' segment: ${e.path}`;
      case 'not-found':                 return `File not found or unreadable: ${e.path}`;
      case 'not-regular-file':          return `Not a regular file: ${e.path}`;
      case 'not-readable':              return `File not readable by server: ${e.path}`;
      case 'outside-allowed-dirs':
        return (
          `Path resolves outside allowed dirs: ${e.path} -> ${e.resolved}. ` +
          'If this file lives in a sandbox the server cannot read (Claude Desktop Workspace, ' +
          'Claude.ai /mnt/user-data/outputs/, remote host), pass it via the inline `attachments` ' +
          'form: [{ filename, content: <base64>, contentType }]. That form does not consult the ' +
          'allow-list and completes in one round-trip.'
        );
      case 'size-exceeds-per-attachment':
        return `Attachment exceeds per-file limit: ${e.path} (${e.sizeBytes} bytes > ${e.limitBytes})`;
      case 'aggregate-size-exceeds':
        return `Aggregate attachments exceed limit at ${e.pendingPath}: ${e.totalBytes} bytes > ${e.limitBytes}`;
      case 'no-allowed-dirs-configured':
        return (
          'No allowed attachment directories configured for path-based attachments. ' +
          'Two ways forward: ' +
          '(a) if your file lives in a sandbox the server cannot read (Claude Desktop Workspace, ' +
          'Claude.ai /mnt/user-data/outputs/, remote host), retry with the inline `attachments` ' +
          'form: [{ filename, content: <base64>, contentType }] — single round-trip, no ' +
          'allow-list involvement; ' +
          '(b) if your file is on this server host, set IMAP_MCP_ALLOWED_ATTACHMENT_DIRS ' +
          '(env, comma-separated absolute paths) or populate users.allowed_attachment_dirs ' +
          'for the active user, then retry with attachmentPaths.'
        );
      case 'dotfile-or-dotdir-rejected':
        return (
          `Refused: path or filename contains a dotfile/dotdir segment ('${e.component}') in ` +
          `${e.path}. Dotfile-prefixed paths (.ssh, .aws, .config, .bashrc, etc.) are denied by ` +
          'default to prevent accidental exfiltration of host secrets. To opt back in for a ' +
          'legitimate dotfile send, set IMAP_MCP_ALLOW_DOTFILES=true on the server.'
        );
      case 'invalid-filename':
        return (
          `Refused: filename '${e.raw}' has no usable basename after sanitization (e.g. it was ` +
          'just a path separator or all control chars). Provide a non-empty filename string.'
        );
    }
  });
}
