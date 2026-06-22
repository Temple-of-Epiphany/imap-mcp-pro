// Minimal ambient declaration for pdf-parse's lib entry (no @types published).
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender?: number;
    info?: unknown;
    metadata?: unknown;
    version?: string;
  }
  function pdf(data: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export default pdf;
}
