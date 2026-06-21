// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// MessageExportService — write messages to disk as standard .eml files.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
// Part of: IMAP MCP Pro (Temple of Epiphany)
//
// .eml is the raw RFC822 source written verbatim: lossless, portable, and
// attachments + inline images + all headers are inherently preserved (they ARE
// the bytes). This service only handles the local-filesystem side; fetching the
// raw source is ImapService.getRawMessages(). All processing is local.

import { promises as fs } from 'fs';
import path from 'path';
import { sanitizeFilename } from './attachment-validator.js';

/**
 * Defense-in-depth: refuse to write outside `baseDir`. Callers already sanitize
 * filenames (basename-stripping) and confine `baseDir` to the per-user outbox,
 * but this guard makes path traversal impossible at the write site regardless
 * of caller behavior (closes the Aikido AIK_ts_generic_path_traversal finding).
 */
function assertInside(baseDir: string, targetPath: string): void {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(targetPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing to write outside the export directory: ${targetPath}`);
  }
}

/** One message to write: raw RFC822 source + envelope bits for the filename. */
export interface ExportItem {
  uid: number;
  source: Buffer;
  subject: string;
  from: string;
  date: Date;
}

export interface ExportedFile {
  uid: number;
  filename: string;
  path: string;
  bytes: number;
}

export interface ExportResult {
  outputDir: string;
  count: number;
  totalBytes: number;
  files: ExportedFile[];
}

export interface AttachmentFile {
  uid: number;
  filename: string;   // original attachment name
  savedAs: string;    // collision-safe on-disk name
  path: string;
  contentType: string;
  bytes: number;
}

/** Collapse a string to a filesystem-safe slug (letters/digits/_/-). */
function slug(input: string, max = 40): string {
  const s = (input || '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')   // non-word → dash
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, max);
  return s || 'untitled';
}

/** Local-date stamp (YYYY-MM-DD) for the filename. */
function dateStamp(d: Date): string {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '0000-00-00';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class MessageExportService {
  /**
   * Build a deterministic, collision-safe `.eml` filename for a message:
   *   YYYY-MM-DD_<from-slug>_<subject-slug>_uid<uid>.eml
   * The trailing UID guarantees uniqueness even for identical subjects/senders.
   */
  buildFilename(item: ExportItem): string {
    const fromLocal = (item.from || '').split('@')[0];
    const name = `${dateStamp(item.date)}_${slug(fromLocal, 24)}_${slug(item.subject, 48)}_uid${item.uid}.eml`;
    return sanitizeFilename(name);
  }

  /**
   * Map an IMAP folder name to a relative on-disk path, mirroring the mailbox
   * hierarchy. Each segment (split on `/` or `.`) is sanitized independently so
   * a folder like `INBOX.Archive.2026` becomes `INBOX/Archive/2026` on disk.
   * Returns '' for the implicit root so callers can join safely.
   */
  folderToDiskPath(folder: string): string {
    const segments = (folder || '')
      .split(/[/.]/)
      .map((s) => sanitizeFilename(s.trim()).replace(/[\\/]/g, ''))
      .filter(Boolean);
    return segments.join(path.sep);
  }

  /**
   * Write each item's raw source as a `.eml` file into `outputDir` (created if
   * needed, mode 0700). Returns a manifest of what was written.
   */
  async exportEml(outputDir: string, items: ExportItem[]): Promise<ExportResult> {
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });

    const files: ExportedFile[] = [];
    let totalBytes = 0;
    for (const item of items) {
      const filename = this.buildFilename(item);
      const fullPath = path.join(outputDir, filename);
      assertInside(outputDir, fullPath);
      await fs.writeFile(fullPath, item.source);
      files.push({ uid: item.uid, filename, path: fullPath, bytes: item.source.length });
      totalBytes += item.source.length;
    }

    return { outputDir, count: files.length, totalBytes, files };
  }

  /**
   * Write decoded attachment buffers to `outputDir`. Filenames are sanitized
   * and made collision-safe by prefixing the source UID (and a counter on
   * duplicates within the same UID).
   */
  async writeAttachments(
    outputDir: string,
    items: Array<{ uid: number; filename: string; content: Buffer; contentType: string }>,
  ): Promise<{ outputDir: string; count: number; totalBytes: number; files: AttachmentFile[] }> {
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });

    const files: AttachmentFile[] = [];
    const used = new Set<string>();
    let totalBytes = 0;
    for (const a of items) {
      const base = sanitizeFilename(a.filename || 'attachment').replace(/[\\/]/g, '') || 'attachment';
      let savedAs = `uid${a.uid}_${base}`;
      for (let n = 1; used.has(savedAs); n++) savedAs = `uid${a.uid}_${n}_${base}`;
      used.add(savedAs);

      const fullPath = path.join(outputDir, savedAs);
      assertInside(outputDir, fullPath);
      await fs.writeFile(fullPath, a.content);
      files.push({ uid: a.uid, filename: a.filename, savedAs, path: fullPath, contentType: a.contentType, bytes: a.content.length });
      totalBytes += a.content.length;
    }

    return { outputDir, count: files.length, totalBytes, files };
  }
}
