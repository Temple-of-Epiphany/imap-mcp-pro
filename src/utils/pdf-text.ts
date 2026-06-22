// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// pdf-text — extract plain text from a PDF buffer (#89).
//
// Uses pdf-parse, imported lazily from its lib entry so (a) the parser is only
// loaded when a PDF is actually encountered, and (b) we avoid pdf-parse's
// index.js debug block (which reads a bundled sample file at import time under
// some loaders). Extraction failures are returned, never thrown, so a malformed
// PDF degrades to "couldn't extract" rather than failing the whole tool call.

export interface PdfTextResult {
  text: string;
  pages: number;
  truncated: boolean;
  error?: string;
}

export async function extractPdfText(buffer: Buffer, maxChars = 100000): Promise<PdfTextResult> {
  try {
    const mod: any = await import('pdf-parse/lib/pdf-parse.js');
    const pdf = (mod.default ?? mod) as (data: Buffer, opts?: any) => Promise<{ text?: string; numpages?: number }>;
    const data = await pdf(buffer);
    const full = (data.text || '').trim();
    const truncated = full.length > maxChars;
    return { text: truncated ? full.slice(0, maxChars) : full, pages: data.numpages ?? 0, truncated };
  } catch (e) {
    return { text: '', pages: 0, truncated: false, error: e instanceof Error ? e.message : String(e) };
  }
}
