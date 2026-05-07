/**
 * Tests for web-ui-manager.ts (v2.17.10, #150).
 *
 * Covers the port-probe helper. The full WebUIManager.start() path is not
 * exercised here because it constructs a live WebUIServer that opens the
 * SQLite db, registers Express routes, and binds a socket — a heavier
 * integration concern best left to a manual smoke test
 * (`node dist/web/server.js`).
 *
 * What this verifies:
 *   - findFreePort returns the preferred port when it is free
 *   - findFreePort skips a port that is currently bound and walks the
 *     +100 increment until it finds a free one
 *   - findFreePort returns null when every candidate in the sweep is taken
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-07
 * Version: 0.1.0
 */

import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { findFreePort } from './web-ui-manager.js';

/** Bind a real TCP server on 127.0.0.1:port and return it. Caller is responsible for closing. */
async function bindOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.once('listening', () => resolve(s));
    s.listen(port, '127.0.0.1');
  });
}

async function closeServer(s: net.Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

// Pick a high, almost-certainly-unused base port for the test sweep so we
// don't collide with the real Web UI default (4500) if it happens to be
// running locally during `npm test`.
const TEST_BASE = 53700;

describe('findFreePort', () => {
  const sockets: net.Server[] = [];

  afterEach(async () => {
    while (sockets.length > 0) {
      const s = sockets.pop()!;
      await closeServer(s);
    }
  });

  it('returns the preferred port when it is free', async () => {
    const result = await findFreePort(TEST_BASE);
    expect(result).toBe(TEST_BASE);
  });

  it('skips a bound port and returns the next +100 candidate', async () => {
    sockets.push(await bindOn(TEST_BASE));
    const result = await findFreePort(TEST_BASE);
    expect(result).toBe(TEST_BASE + 100);
  });

  it('walks multiple +100 candidates when the first few are bound', async () => {
    sockets.push(await bindOn(TEST_BASE));
    sockets.push(await bindOn(TEST_BASE + 100));
    sockets.push(await bindOn(TEST_BASE + 200));
    const result = await findFreePort(TEST_BASE);
    expect(result).toBe(TEST_BASE + 300);
  });

  it('returns null when every candidate in the sweep is taken', async () => {
    // The probe attempts 10 candidates spaced 100 apart. Bind all of them.
    for (let i = 0; i < 10; i++) {
      sockets.push(await bindOn(TEST_BASE + i * 100));
    }
    const result = await findFreePort(TEST_BASE);
    expect(result).toBeNull();
  });
});
