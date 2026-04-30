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
  | { kind: 'no-allowed-dirs-configured' };

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
 * Per RFC 2183: filenames must not contain path separators or control
 * chars. We also strip leading dots (avoid hidden-file confusion) and
 * cap to 255 bytes UTF-8.
 */
export function sanitizeFilename(filename: string): string {
  const noSep = filename.replace(/[\/\\]/g, '_');
  const noCtl = noSep.replace(/[\x00-\x1f\x7f]/g, '');
  const noLeadDot = noCtl.replace(/^\.+/, '');
  return noLeadDot.slice(0, 255);
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

    let realPath: string;
    try {
      realPath = await fs.promises.realpath(p);
    } catch {
      errors.push({ kind: 'not-found', path: p });
      continue;
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
      case 'outside-allowed-dirs':      return `Path resolves outside allowed dirs: ${e.path} -> ${e.resolved}`;
      case 'size-exceeds-per-attachment':
        return `Attachment exceeds per-file limit: ${e.path} (${e.sizeBytes} bytes > ${e.limitBytes})`;
      case 'aggregate-size-exceeds':
        return `Aggregate attachments exceed limit at ${e.pendingPath}: ${e.totalBytes} bytes > ${e.limitBytes}`;
      case 'no-allowed-dirs-configured':
        return 'No allowed attachment directories configured. Set IMAP_MCP_ALLOWED_ATTACHMENT_DIRS or users.allowed_attachment_dirs.';
    }
  });
}
