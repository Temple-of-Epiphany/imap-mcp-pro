/**
 * Email Parser Worker
 *
 * Runs in a node:worker_threads context. Handles three task types:
 *   - 'parse-rfc822'    Parse a raw RFC822 buffer to a structured object
 *                        + 200-char preview, with attachment metadata.
 *   - 'summarize-rows'  Build StoredResultRowSummary[] from raw rows.
 *   - 'filter-rows'     Apply serializable predicates to a row array.
 *
 * Author: Temple of Epiphany
 * Date: 2026-04-18
 */

import { parentPort } from 'worker_threads';
import { simpleParser } from 'mailparser';

if (!parentPort) {
  throw new Error('email-parser-worker must be loaded as a worker thread');
}

interface ParseRfc822Payload {
  raw: ArrayBuffer | Uint8Array | Buffer;
  wantText?: boolean;
  wantHtml?: boolean;
  previewChars?: number;
  attachmentMaxBytes?: number;   // skip blobs over this size
}

interface ParsedAttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  skipped?: boolean;             // true = oversize, content not returned
  content?: Buffer;              // present only when not skipped
}

interface ParseRfc822Result {
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  messageId?: string;
  textPreview?: string;
  htmlPreview?: string;
  fullText?: string;
  fullHtml?: string;
  attachments: ParsedAttachmentMeta[];
}

interface SummarizeRowsPayload {
  rows: any[];
  previewChars?: number;
}

interface FilterRowsPayload {
  rows: any[];
  predicates: {
    fromIncludes?: string;
    subjectIncludes?: string;
    flagIncludes?: string;
    flagExcludes?: string;
    dateAfter?: string;          // ISO
    dateBefore?: string;         // ISO
  };
}

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n) : s;
}

function fmtAddress(a: any): string | undefined {
  if (!a) return undefined;
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return a.map(fmtAddress).filter(Boolean).join(', ');
  if (a.text) return a.text;
  if (a.value && Array.isArray(a.value)) {
    return a.value.map((v: any) => v.address || v.name).filter(Boolean).join(', ');
  }
  return undefined;
}

async function handleParseRfc822(p: ParseRfc822Payload): Promise<ParseRfc822Result> {
  const raw = Buffer.isBuffer(p.raw)
    ? p.raw
    : Buffer.from(p.raw as ArrayBuffer);
  const previewChars = p.previewChars ?? 200;
  const maxBytes = p.attachmentMaxBytes ?? 10 * 1024 * 1024;

  const parsed = await simpleParser(raw);

  const attachments: ParsedAttachmentMeta[] = [];
  if (parsed.attachments && parsed.attachments.length) {
    for (const a of parsed.attachments) {
      const filename = a.filename ?? 'unnamed';
      const contentType = a.contentType ?? 'application/octet-stream';
      const size = a.size ?? (a.content ? a.content.length : 0);
      if (size > maxBytes) {
        attachments.push({ filename, contentType, size, skipped: true });
      } else {
        attachments.push({
          filename,
          contentType,
          size,
          contentId: a.contentId,
          content: a.content as Buffer,
        });
      }
    }
  }

  const out: ParseRfc822Result = {
    subject: parsed.subject,
    from: fmtAddress(parsed.from),
    to: fmtAddress(parsed.to),
    cc: fmtAddress(parsed.cc),
    date: parsed.date ? parsed.date.toISOString() : undefined,
    messageId: parsed.messageId,
    textPreview: truncate(parsed.text, previewChars),
    htmlPreview: p.wantHtml ? truncate(parsed.html || '', previewChars) : undefined,
    fullText: p.wantText ? parsed.text : undefined,
    fullHtml: p.wantHtml ? (parsed.html || undefined) : undefined,
    attachments,
  };
  return out;
}

function handleSummarizeRows(p: SummarizeRowsPayload): any[] {
  const previewChars = p.previewChars ?? 200;
  return p.rows.map((r: any) => {
    const preview =
      typeof r.preview === 'string'
        ? r.preview
        : typeof r.text === 'string'
          ? r.text
          : typeof r.bodyPreview === 'string'
            ? r.bodyPreview
            : undefined;
    return {
      uid: r.uid,
      subject: r.subject,
      from: fmtAddress(r.from),
      to: fmtAddress(r.to),
      date: r.date ? (r.date instanceof Date ? r.date.toISOString() : r.date) : undefined,
      flags: Array.isArray(r.flags) ? r.flags : (r.flags ? [...r.flags] : undefined),
      preview: truncate(preview, previewChars),
      size: r.size,
      hasAttachments: r.hasAttachments ?? (r.attachments && r.attachments.length > 0),
    };
  });
}

function handleFilterRows(p: FilterRowsPayload): any[] {
  const { predicates: pr } = p;
  const after = pr.dateAfter ? new Date(pr.dateAfter).getTime() : null;
  const before = pr.dateBefore ? new Date(pr.dateBefore).getTime() : null;
  return p.rows.filter((r: any) => {
    if (pr.fromIncludes && !(r.from || '').toString().toLowerCase()
        .includes(pr.fromIncludes.toLowerCase())) return false;
    if (pr.subjectIncludes && !(r.subject || '').toString().toLowerCase()
        .includes(pr.subjectIncludes.toLowerCase())) return false;
    if (pr.flagIncludes && !(Array.isArray(r.flags) && r.flags.includes(pr.flagIncludes))) return false;
    if (pr.flagExcludes && Array.isArray(r.flags) && r.flags.includes(pr.flagExcludes)) return false;
    if (after !== null) {
      const d = r.date ? new Date(r.date).getTime() : null;
      if (d === null || d < after) return false;
    }
    if (before !== null) {
      const d = r.date ? new Date(r.date).getTime() : null;
      if (d === null || d > before) return false;
    }
    return true;
  });
}

async function dispatch(task: { type: string; payload: any }): Promise<any> {
  switch (task.type) {
    case 'parse-rfc822':
      return handleParseRfc822(task.payload as ParseRfc822Payload);
    case 'summarize-rows':
      return handleSummarizeRows(task.payload as SummarizeRowsPayload);
    case 'filter-rows':
      return handleFilterRows(task.payload as FilterRowsPayload);
    default:
      throw new Error(`Unknown task type: ${task.type}`);
  }
}

parentPort.on('message', async (msg: { id: number; task: { type: string; payload: any } }) => {
  try {
    const result = await dispatch(msg.task);
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (e: any) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: e?.message ?? String(e),
    });
  }
});
