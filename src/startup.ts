/**
 * Three-stage startup orchestrator
 *
 * Pre-handshake (target < 2s):
 *   - Load + validate config
 *   - Construct DatabaseService (auto-migration runs here; ledger v1.7.0
 *     means usually nothing pending and the cost is bounded)
 *   - Construct downstream services
 *   - Register tool schemas with the SDK
 *
 * Handshake:
 *   - server.connect(transport) — SDK handles initialize/initialized exchange
 *
 * Post-handshake (detached, doesn't block tool invocation):
 *   - Orphan-file sweep
 *   - Background warm-up
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-04-29
 * Date Updated: 2026-04-29
 * Version: 0.1.0
 *
 * Tracker: #102. Phase 3 issue: #105.
 */

import { ServerConfig } from './config/server-config.js';

export interface StartupLog {
  stage: 'pre-handshake' | 'handshake' | 'post-handshake';
  outcome: 'in_progress' | 'ok' | 'error';
  durationMs?: number;
  error?: string;
  detail?: string;
}

/**
 * Structured logger — single line per event, easy to grep, no deps.
 *
 * Goes to stderr (Claude Desktop captures stderr to per-server log files).
 */
export function logEvent(component: string, fields: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const parts: string[] = [ts, component];
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') parts.push(`${k}=${v}`);
    else parts.push(`${k}=${JSON.stringify(v)}`);
  }
  process.stderr.write(parts.join(' ') + '\n');
}

/**
 * Time a stage, log start + completion, return value of the inner function.
 * On error, logs the error and rethrows.
 */
export async function timeStage<T>(
  stage: StartupLog['stage'],
  fn: () => T | Promise<T>
): Promise<T> {
  const t0 = Date.now();
  logEvent('[startup]', { stage, outcome: 'in_progress' });
  try {
    const result = await fn();
    const durationMs = Date.now() - t0;
    logEvent('[startup]', { stage, outcome: 'ok', duration_ms: durationMs });
    if (stage === 'pre-handshake' && durationMs > 2000) {
      logEvent('[startup]', {
        stage,
        outcome: 'warning',
        msg: 'pre-handshake exceeded 2s budget',
        duration_ms: durationMs,
      });
    }
    return result;
  } catch (e: any) {
    const durationMs = Date.now() - t0;
    logEvent('[startup]', {
      stage,
      outcome: 'error',
      duration_ms: durationMs,
      error: e?.message ?? String(e),
    });
    throw e;
  }
}

/**
 * Capabilities to advertise on the MCP initialize handshake.
 *
 * We declare:
 *   - tools: { listChanged: false } — we serve tools, but don't push
 *     listChanged notifications.
 *
 * We deliberately omit:
 *   - resources: we serve none.
 *   - prompts: we serve none.
 *   - logging: we don't expose log streaming via MCP yet.
 *
 * Closes #80 (explicit capability negotiation).
 */
export const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
} as const;

/**
 * Decide whether a logged stderr line should be suppressed in the
 * Claude-Desktop-extension context. Currently passes everything through —
 * the extension log captures stderr verbatim. Reserved for future filtering.
 */
export function shouldEmitLog(_config: ServerConfig, _level: string): boolean {
  return true;
}
