/**
 * web-ui-manager.ts — owns the embedded WebUIServer lifecycle when the MCP
 * server runs as a Claude Desktop extension.
 *
 * Responsibilities:
 *   - Probe ports starting at the preferred port, increment by 100 on
 *     EADDRINUSE, give up after MAX_ATTEMPTS so we don't loop forever.
 *   - Hold the running WebUIServer instance for the process lifetime.
 *   - Surface the live URL to the imap_open_web_ui MCP tool.
 *
 * Port-probe choice (4500 -> 4600 -> 4700 ...): per #150 spec — increment
 * by 100 rather than 1, so a parallel project on 4501-4503 doesn't push us
 * onto a port the user can't easily predict. After MAX_ATTEMPTS (10) the
 * range 4500..5400 has been swept; that is well beyond the realistic
 * collision space for a personal machine.
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-07
 * Version: 0.1.0
 *
 * Tracker: #150 (Web UI not bundled into .mcpb / broken in dev).
 */

import net from 'net';
import { WebUIServer } from '../web/server.js';
import { DatabaseService } from './database-service.js';
import { ImapService } from './imap-service.js';

const PORT_INCREMENT = 100;
const MAX_PORT_ATTEMPTS = 10;
const DEFAULT_PORT = 4500;

/** Probe whether `port` can be bound on 127.0.0.1 right now. */
async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

/**
 * Find a free port starting at `preferred`, incrementing by `PORT_INCREMENT`
 * up to `MAX_PORT_ATTEMPTS` times. Returns null if every candidate is taken.
 */
export async function findFreePort(preferred: number): Promise<number | null> {
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const candidate = preferred + i * PORT_INCREMENT;
    if (await isPortFree(candidate)) return candidate;
  }
  return null;
}

export class WebUIManager {
  private instance: WebUIServer | null = null;
  private url: string | null = null;
  private port: number | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly imapService: ImapService,
  ) {}

  /** True if the embedded Web UI is currently running. */
  isRunning(): boolean { return this.instance !== null; }

  /** Live URL, or null if not yet started. */
  getUrl(): string | null { return this.url; }

  /** Live port, or null if not yet started. */
  getPort(): number | null { return this.port; }

  /**
   * Start the Web UI on the first free port at or above `preferredPort`.
   * Idempotent — if the server is already running, returns the existing URL
   * unchanged.
   *
   * `autoOpen` controls whether a browser tab is launched. Default false:
   * the always-on extension boot should not pop a tab on every Claude Desktop
   * launch. The imap_open_web_ui MCP tool can pass `autoOpen: true` to do so
   * deliberately when the user asks.
   */
  async start(opts: { preferredPort?: number; autoOpen?: boolean } = {}): Promise<{
    url: string;
    port: number;
    alreadyRunning: boolean;
    triedPorts?: number[];
  }> {
    if (this.instance && this.url && this.port !== null) {
      return { url: this.url, port: this.port, alreadyRunning: true };
    }

    const preferred = opts.preferredPort
      ?? Number(process.env.IMAP_MCP_WEB_UI_PORT ?? DEFAULT_PORT);

    const triedPorts: number[] = [];
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const candidate = preferred + i * PORT_INCREMENT;
      triedPorts.push(candidate);
      if (await isPortFree(candidate)) {
        const server = new WebUIServer({
          port: candidate,
          db: this.db,
          imapService: this.imapService,
        });
        await server.start(opts.autoOpen ?? false);
        this.instance = server;
        this.port = candidate;
        this.url = server.getUrl();
        return { url: this.url, port: this.port, alreadyRunning: false, triedPorts };
      }
    }

    const range = `${preferred}..${preferred + (MAX_PORT_ATTEMPTS - 1) * PORT_INCREMENT}`;
    throw new Error(
      `[WebUIManager] Could not find a free port in the range ${range} ` +
      `(probed ${MAX_PORT_ATTEMPTS} candidates spaced ${PORT_INCREMENT} apart). ` +
      `Set IMAP_MCP_WEB_UI_PORT (or the user_config slider in Claude Desktop) ` +
      `to a different starting port.`
    );
  }
}
