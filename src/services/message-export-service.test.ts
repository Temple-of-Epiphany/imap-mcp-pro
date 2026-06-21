// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { MessageExportService, ExportItem } from './message-export-service.js';

function item(overrides: Partial<ExportItem> = {}): ExportItem {
  return {
    uid: 7,
    source: Buffer.from('From: a@x.com\r\nSubject: Hi\r\n\r\nbody\r\n'),
    subject: 'Quarterly Report',
    from: 'sender@example.com',
    date: new Date('2026-03-04T12:00:00'),
    ...overrides,
  };
}

describe('MessageExportService.buildFilename', () => {
  const svc = new MessageExportService();

  it('builds a date_from_subject_uid .eml name', () => {
    expect(svc.buildFilename(item())).toBe('2026-03-04_sender_Quarterly-Report_uid7.eml');
  });

  it('sanitizes unsafe characters and slashes', () => {
    const name = svc.buildFilename(item({ subject: 'Re: invoice / 2026 *final*', from: 'a/b@x.com', uid: 12 }));
    expect(name.endsWith('_uid12.eml')).toBe(true);
    expect(name).not.toMatch(/[\\/*]/);
  });

  it('falls back to "untitled" for empty subject/from', () => {
    const name = svc.buildFilename(item({ subject: '', from: '', uid: 3 }));
    expect(name).toBe('2026-03-04_untitled_untitled_uid3.eml');
  });
});

describe('MessageExportService.folderToDiskPath', () => {
  const svc = new MessageExportService();
  const sep = path.sep;

  it('mirrors a namespaced folder hierarchy to nested dirs', () => {
    expect(svc.folderToDiskPath('INBOX.Archive.2026')).toBe(['INBOX', 'Archive', '2026'].join(sep));
    expect(svc.folderToDiskPath('INBOX/Sent Items')).toBe(['INBOX', 'Sent Items'].join(sep));
  });

  it('handles a single-segment folder', () => {
    expect(svc.folderToDiskPath('Sent')).toBe('Sent');
  });

  it('neutralizes traversal and drops empty segments', () => {
    // split-on-"." turns ".." into empty segments, which are filtered out.
    expect(svc.folderToDiskPath('A/../weird')).toBe(['A', 'weird'].join(sep));
    expect(svc.folderToDiskPath('//Sent//')).toBe('Sent');
  });
});

describe('MessageExportService.exportEml', () => {
  let dir: string;
  const svc = new MessageExportService();
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mexport-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('writes each message as a .eml file with verbatim source and returns a manifest', async () => {
    const out = path.join(dir, 'exports');
    const items = [
      item({ uid: 1, source: Buffer.from('RAW-ONE') }),
      item({ uid: 2, source: Buffer.from('RAW-TWO-LONGER') }),
    ];
    const res = await svc.exportEml(out, items);

    expect(res.count).toBe(2);
    expect(res.totalBytes).toBe(Buffer.from('RAW-ONE').length + Buffer.from('RAW-TWO-LONGER').length);
    expect(res.files).toHaveLength(2);

    for (const f of res.files) {
      const onDisk = await fs.readFile(f.path);
      const original = items.find(i => i.uid === f.uid)!.source;
      expect(onDisk.equals(original)).toBe(true); // lossless, verbatim
      expect(f.path.startsWith(out)).toBe(true);
      expect(f.filename.endsWith('.eml')).toBe(true);
    }
  });

  it('creates the output directory if missing', async () => {
    const nested = path.join(dir, 'a', 'b', 'exports');
    const res = await svc.exportEml(nested, [item()]);
    expect(res.count).toBe(1);
    await expect(fs.stat(nested)).resolves.toBeTruthy();
  });

  it('returns an empty manifest for no items', async () => {
    const res = await svc.exportEml(path.join(dir, 'empty'), []);
    expect(res).toMatchObject({ count: 0, totalBytes: 0, files: [] });
  });
});

describe('MessageExportService.writeAttachments', () => {
  let dir: string;
  const svc = new MessageExportService();
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mexport-att-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('writes attachments UID-prefixed with verbatim bytes', async () => {
    const out = path.join(dir, 'att');
    const res = await svc.writeAttachments(out, [
      { uid: 5, filename: 'report.pdf', content: Buffer.from('PDFBYTES'), contentType: 'application/pdf' },
    ]);
    expect(res.count).toBe(1);
    expect(res.files[0].savedAs).toBe('uid5_report.pdf');
    expect((await fs.readFile(res.files[0].path)).toString()).toBe('PDFBYTES');
  });

  it('disambiguates duplicate filenames within the same UID', async () => {
    const res = await svc.writeAttachments(path.join(dir, 'att2'), [
      { uid: 9, filename: 'a.txt', content: Buffer.from('one'), contentType: 'text/plain' },
      { uid: 9, filename: 'a.txt', content: Buffer.from('two'), contentType: 'text/plain' },
    ]);
    const names = res.files.map((f) => f.savedAs);
    expect(new Set(names).size).toBe(2);          // no collision
    expect(names).toContain('uid9_a.txt');
  });

  it('sanitizes unsafe attachment names and falls back when empty', async () => {
    const res = await svc.writeAttachments(path.join(dir, 'att3'), [
      { uid: 1, filename: '../../etc/passwd', content: Buffer.from('x'), contentType: 'text/plain' },
    ]);
    expect(res.files[0].savedAs).not.toMatch(/[\\/]/);
    expect(res.files[0].savedAs.startsWith('uid1_')).toBe(true);
  });

  it('keeps every written file inside the output dir for adversarial names (path-traversal guard, #203)', async () => {
    const out = path.join(dir, 'att4');
    const res = await svc.writeAttachments(out, [
      { uid: 1, filename: '../../../../etc/passwd', content: Buffer.from('a'), contentType: 'text/plain' },
      { uid: 2, filename: '..\\..\\windows\\system32\\evil', content: Buffer.from('b'), contentType: 'text/plain' },
    ]);
    const base = path.resolve(out);
    for (const f of res.files) {
      expect(path.resolve(f.path).startsWith(base + path.sep)).toBe(true); // never escapes
    }
  });
});
