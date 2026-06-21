// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from 'vitest';
import { UnsubscribeService } from './unsubscribe-service.js';

const svc = new UnsubscribeService({} as any); // extractWithMeta doesn't touch the DB

function raw(headers: Record<string, string>, body: string, contentType = 'text/plain'): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  lines.push(`Content-Type: ${contentType}`, '', body, '');
  return lines.join('\r\n');
}

describe('UnsubscribeService.extractWithMeta', () => {
  it('extracts header links + sender + recipient + subject', async () => {
    const source = raw({
      From: 'Acme News <news@acme.com>',
      To: 'me@example.com',
      Subject: 'Weekly Digest',
      'List-Unsubscribe': '<https://acme.com/unsub?id=1>, <mailto:unsub@acme.com>',
    }, 'hello');

    const r = await svc.extractWithMeta(source);
    expect(r.from).toBe('news@acme.com');
    expect(r.to).toBe('me@example.com');          // recipient captured (#194)
    expect(r.subject).toBe('Weekly Digest');
    expect(r.info.unsubscribe_method).toBe('both');
    expect(r.info.unsubscribe_link).toBe('https://acme.com/unsub?id=1');
    expect(r.info.list_unsubscribe_header).toContain('mailto:unsub@acme.com');
  });

  it('falls back to a body link when no header is present', async () => {
    const source = raw(
      { From: 'a@x.com', To: 'b@x.com', Subject: 'Promo' },
      '<html><body><a href="https://x.com/unsubscribe?u=9">Unsubscribe</a></body></html>',
      'text/html',
    );
    const r = await svc.extractWithMeta(source);
    expect(r.to).toBe('b@x.com');
    expect(r.info.unsubscribe_link).toContain('unsubscribe');
    expect(r.info.unsubscribe_method).toBe('http');
  });

  it('reports no link for a plain message', async () => {
    const source = raw({ From: 'a@x.com', To: 'b@x.com', Subject: 'Hi' }, 'just a note');
    const r = await svc.extractWithMeta(source);
    expect(r.info.unsubscribe_link).toBeUndefined();
    expect(r.info.list_unsubscribe_header).toBeUndefined();
    expect(r.to).toBe('b@x.com');
  });

  it('captures multiple recipients as a comma-joined string', async () => {
    const source = raw({ From: 'a@x.com', To: 'b@x.com, c@x.com', Subject: 'Hi' }, 'note');
    const r = await svc.extractWithMeta(source);
    expect(r.to).toBe('b@x.com, c@x.com');
  });
});
