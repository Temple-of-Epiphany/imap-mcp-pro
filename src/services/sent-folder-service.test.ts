// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it, vi } from 'vitest';
import { SentFolderService } from './sent-folder-service.js';

const stmt = { run: () => {}, get: () => undefined }; // no cache hit
function makeSvc(folders: any[], host = 'imap.example.com', createFolder = vi.fn(async () => {})) {
  const db: any = { getAccount: () => ({ host }), getDb: () => ({ prepare: () => stmt }) };
  const imap: any = { listFolders: async () => folders, createFolder };
  return { svc: new SentFolderService(db, imap), createFolder };
}
const folder = (name: string, attributes: string[] = []) => ({ name, delimiter: '/', attributes, children: [] });

describe('SentFolderService.resolveSentFolder — detection', () => {
  it('resolves via RFC 6154 \\Sent SPECIAL-USE', async () => {
    const { svc } = makeSvc([folder('INBOX'), folder('Verzonden', ['\\Sent'])]);
    const r = await svc.resolveSentFolder('a');
    expect(r).toMatchObject({ folderName: 'Verzonden', method: 'special_use' });
  });

  it('resolves a namespaced "INBOX.Sent" by leaf name', async () => {
    const { svc } = makeSvc([folder('INBOX'), folder('INBOX.Sent')]);
    const r = await svc.resolveSentFolder('a');
    expect(r).toMatchObject({ folderName: 'INBOX.Sent', method: 'fallback' });
  });

  it('resolves a localized Sent folder (Enviados)', async () => {
    const { svc } = makeSvc([folder('INBOX'), folder('Enviados')]);
    const r = await svc.resolveSentFolder('a');
    expect(r.folderName).toBe('Enviados');
  });

  it('resolves case-insensitively ("sent items")', async () => {
    const { svc } = makeSvc([folder('INBOX'), folder('sent items')]);
    const r = await svc.resolveSentFolder('a');
    expect(r.folderName).toBe('sent items');
  });

  it('honors an explicit override', async () => {
    const { svc } = makeSvc([folder('INBOX')]);
    const r = await svc.resolveSentFolder('a', { override: 'Archive/Sent' });
    expect(r).toMatchObject({ folderName: 'Archive/Sent', method: 'override' });
  });

  it('fails with folderName=null and lists available folders when no Sent folder exists', async () => {
    const { svc } = makeSvc([folder('INBOX'), folder('Drafts'), folder('Junk')]);
    const r = await svc.resolveSentFolder('a');
    expect(r.folderName).toBeNull();
    expect(r.method).toBe('failed');
    expect(r.availableFolders).toEqual(['INBOX', 'Drafts', 'Junk']);
  });

  it('auto-creates "Sent" only when autoCreate is enabled', async () => {
    const { svc, createFolder } = makeSvc([folder('INBOX'), folder('Drafts')]);
    const r = await svc.resolveSentFolder('a', { autoCreate: true });
    expect(createFolder).toHaveBeenCalledWith('a', 'Sent');
    expect(r).toMatchObject({ folderName: 'Sent', method: 'auto_created' });
  });
});
