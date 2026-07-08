// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// Tests for AccountSerializer — the per-account concurrency guard (#280).

import { describe, expect, it } from 'vitest';
import { AccountSerializer } from './account-serial.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('AccountSerializer', () => {
  it('serializes operations on the same key (no interleaving)', async () => {
    const s = new AccountSerializer();
    const events: string[] = [];
    // Simulate SELECT+op: enter (SELECT), await, exit (op reads current folder).
    const op = (id: string) => s.run('acct', async () => {
      events.push(`enter:${id}`);
      await tick(5);
      events.push(`exit:${id}`);
    });
    await Promise.all([op('A'), op('B'), op('C')]);
    // Each op's enter must be immediately followed by its own exit — no
    // interleaving like enter:A, enter:B, exit:A.
    expect(events).toEqual([
      'enter:A', 'exit:A',
      'enter:B', 'exit:B',
      'enter:C', 'exit:C',
    ]);
  });

  it('reproduces the #280 cross-contamination WITHOUT the guard, and fixes it WITH it', async () => {
    // Shared "connection": mailboxOpen sets currentFolder; the op reads it back
    // after an await. Concurrent unguarded runs leak one folder into another.
    let currentFolder = '';
    const unguarded = async (folder: string) => {
      currentFolder = folder;          // SELECT
      await tick(5);                   // yield mid-operation
      return currentFolder;            // SEARCH sees whatever folder is selected now
    };
    const bad = await Promise.all([unguarded('INBOX'), unguarded('Junk'), unguarded('Archive')]);
    expect(bad).toEqual(['Archive', 'Archive', 'Archive']); // all leaked to the last SELECT

    const s = new AccountSerializer();
    const guarded = (folder: string) => s.run('acct', () => unguarded(folder));
    const good = await Promise.all([guarded('INBOX'), guarded('Junk'), guarded('Archive')]);
    expect(good).toEqual(['INBOX', 'Junk', 'Archive']); // each op sees its own folder
  });

  it('is re-entrant: a held key run inline (getMultipleMailboxStatus -> getMailboxStatus)', async () => {
    const s = new AccountSerializer();
    let deadlocked = true;
    await s.run('acct', async () => {
      // Nested call on the same key must NOT wait on the outer lock.
      const inner = await s.run('acct', async () => {
        expect(s.holds('acct')).toBe(true);
        return 42;
      });
      expect(inner).toBe(42);
      deadlocked = false;
    });
    expect(deadlocked).toBe(false);
  });

  it('runs different keys concurrently', async () => {
    const s = new AccountSerializer();
    const order: string[] = [];
    await Promise.all([
      s.run('A', async () => { order.push('A-start'); await tick(10); order.push('A-end'); }),
      s.run('B', async () => { order.push('B-start'); await tick(1); order.push('B-end'); }),
    ]);
    // B (different key) is not blocked by A: it starts and finishes during A's await.
    expect(order.indexOf('B-end')).toBeLessThan(order.indexOf('A-end'));
    expect(order.slice(0, 2).sort()).toEqual(['A-start', 'B-start']);
  });

  it('a failed op does not wedge the queue', async () => {
    const s = new AccountSerializer();
    await expect(s.run('acct', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The next op on the same key still runs.
    await expect(s.run('acct', async () => 'ok')).resolves.toBe('ok');
  });
});
