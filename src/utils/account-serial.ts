// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
//
// account-serial.ts — per-key re-entrant serialization (#280).
//
// An IMAP connection is a single stateful channel: exactly one mailbox is
// SELECTed at a time and a folder-scoped operation is really a SELECT followed
// by SEARCH/FETCH/STORE. If two such operations run concurrently over one
// shared connection, ImapFlow interleaves them and one operation's SELECT
// redefines the current mailbox mid-flight for the other — yielding silently
// wrong counts/search results (#280).
//
// AccountSerializer serializes operations per key (account id) so each
// SELECT+operation runs to completion before the next begins. It is
// RE-ENTRANT: a serialized operation that internally calls another serialized
// operation on the SAME key runs inline instead of deadlocking on a lock it
// already holds (e.g. getMultipleMailboxStatus -> getMailboxStatus). Different
// keys run concurrently (different accounts don't share a connection).

import { AsyncLocalStorage } from 'node:async_hooks';

export class AccountSerializer {
  /** Tail of each key's promise chain. Absent when the key is idle. */
  private chains = new Map<string, Promise<void>>();
  /** Set of keys whose critical section the current async context holds. */
  private held = new AsyncLocalStorage<Set<string>>();

  /**
   * Run `fn` in `key`'s serial queue. Re-entrant calls on a key already held
   * by the current async context run immediately (no re-queue, no deadlock).
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.held.getStore();
    if (current?.has(key)) {
      return fn();
    }

    const prev = this.chains.get(key) ?? Promise.resolve();
    const result = prev.then(() => {
      const next = new Set(current ?? []);
      next.add(key);
      return this.held.run(next, fn);
    });

    // The stored tail swallows errors so one failed op never wedges the queue,
    // and drops the map entry once this is the last op so the map stays bounded.
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });

    return result;
  }

  /** True if the current async context is inside `key`'s critical section. */
  holds(key: string): boolean {
    return this.held.getStore()?.has(key) ?? false;
  }
}
