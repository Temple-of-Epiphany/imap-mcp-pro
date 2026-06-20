// SPDX-License-Identifier: LicenseRef-ImapMcpPro-Dual
//
// Tests for SmtpService transport assembly + lifecycle.
//
// Author:  Colin Bitterfield <colin.bitterfield@templeofepiphany.com>
//
// nodemailer is mocked so we can assert the transport config SmtpService
// derives (default-config heuristic, auth fallback), transporter caching,
// and disconnect behavior without opening a real SMTP socket.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const created: any[] = [];
const closed: string[] = [];

vi.mock('nodemailer', () => {
  return {
    default: {
      createTransport: (cfg: any) => {
        const transporter = {
          cfg,
          verify: async () => true,
          close: () => closed.push(cfg.host),
          sendMail: async () => ({ messageId: '<id@test>' }),
        };
        created.push(transporter);
        return transporter;
      },
    },
  };
});

import { SmtpService } from './smtp-service.js';

function account(overrides: Record<string, any> = {}) {
  return {
    id: 'acc-1', name: 'A', host: 'imap.example.com', port: 993,
    user: 'me@example.com', password: 'secret', tls: true,
    ...overrides,
  } as any;
}

describe('SmtpService.createTransporter', () => {
  beforeEach(() => { created.length = 0; closed.length = 0; });

  it('maps a known IMAP host to its documented submission server', async () => {
    const svc = new SmtpService({ pool: { healthCheck: false } });
    await svc.createTransporter(account({ host: 'imap.gmail.com' }));
    expect(created[0].cfg).toMatchObject({ host: 'smtp.gmail.com', port: 587, secure: false });
  });

  it('derives an SMTP host from the IMAP host for unknown providers', async () => {
    const svc = new SmtpService({ pool: { healthCheck: false } });
    await svc.createTransporter(account({ host: 'imap.example.com', tls: true, port: 993 }));
    expect(created[0].cfg).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true });
  });

  it('falls back to IMAP credentials when SMTP auth is unset', async () => {
    const svc = new SmtpService({ pool: { healthCheck: false } });
    await svc.createTransporter(account());
    expect(created[0].cfg.auth).toEqual({ user: 'me@example.com', pass: 'secret' });
  });

  it('honors explicit account.smtp settings over the default heuristic', async () => {
    const svc = new SmtpService({ pool: { healthCheck: false } });
    await svc.createTransporter(account({ smtp: { host: 'smtp.custom.tld', port: 2525, secure: false, user: 'u', password: 'p' } }));
    expect(created[0].cfg).toMatchObject({ host: 'smtp.custom.tld', port: 2525 });
    expect(created[0].cfg.auth).toEqual({ user: 'u', pass: 'p' });
  });

  it('caches one transporter per account', async () => {
    const svc = new SmtpService({ pool: { healthCheck: false } });
    const a = await svc.createTransporter(account());
    const b = await svc.createTransporter(account());
    expect(a).toBe(b);
    expect(created.length).toBe(1);
    expect(svc.getPoolStats()).toEqual({ configured: 1 });
  });
});

describe('SmtpService lifecycle', () => {
  beforeEach(() => { created.length = 0; closed.length = 0; });

  it('disconnect closes and drops a single account transporter', async () => {
    const svc = new SmtpService({ pool: { healthCheck: false } });
    await svc.createTransporter(account({ host: 'imap.gmail.com' }));
    svc.disconnect('acc-1');
    expect(closed).toEqual(['smtp.gmail.com']);
    expect(svc.getPoolStats()).toEqual({ configured: 0 });
    expect(() => svc.disconnect('acc-1')).not.toThrow();
  });

  it('disconnectAll closes every transporter and clears the pool', async () => {
    const svc = new SmtpService({ pool: { healthCheck: false } });
    await svc.createTransporter(account({ id: 'a1', host: 'imap.gmail.com' }));
    await svc.createTransporter(account({ id: 'a2', host: 'imap.mail.yahoo.com' }));
    svc.disconnectAll();
    expect(closed.sort()).toEqual(['smtp.gmail.com', 'smtp.mail.yahoo.com']);
    expect(svc.getPoolStats()).toEqual({ configured: 0 });
  });

  it('verifySmtpConnection returns true on success', async () => {
    const svc = new SmtpService({ pool: { healthCheck: false } });
    expect(await svc.verifySmtpConnection(account())).toBe(true);
  });
});
