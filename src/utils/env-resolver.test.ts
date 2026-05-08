/**
 * Tests for env-resolver.ts (#156).
 *
 * Covers:
 *   - ${HOME} / ${USER} expansion in env values
 *   - Lingering literal ${user_config.X} placeholders are cleared
 *   - Recovery of IMAP_MCP_ALLOWED_ATTACHMENT_DIRS from a settings JSON
 *     when the env was never set or got cleared
 *   - No-op when env is well-formed
 *
 * Author: Colin Bitterfield
 * Email: colin.bitterfield@templeofepiphany.com
 * Date Created: 2026-05-08
 * Version: 0.1.0
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEnvPlaceholders } from './env-resolver.js';

const SAVED_ENV = new Map<string, string | undefined>();
const SAVED_KEYS = [
  'IMAP_MCP_DATABASE_PATH',
  'IMAP_MCP_LOG_LEVEL',
  'IMAP_MCP_ALLOWED_ATTACHMENT_DIRS',
  'IMAP_MCP_ENCRYPTION_KEY',
  'IMAP_MCP_MAX_ATTACHMENT_SIZE_BYTES',
  'IMAP_MCP_ALLOW_DOTFILES',
  'IMAP_MCP_WEB_UI_PORT',
  'IMAP_MCP_TEST_FAKE',
];

function snapshotEnv() {
  for (const k of SAVED_KEYS) SAVED_ENV.set(k, process.env[k]);
}
function restoreEnv() {
  for (const k of SAVED_KEYS) {
    const v = SAVED_ENV.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  SAVED_ENV.clear();
}

describe('resolveEnvPlaceholders — ${HOME}/${USER} expansion', () => {
  beforeEach(snapshotEnv);
  afterEach(restoreEnv);

  it('expands ${HOME} in IMAP_MCP_DATABASE_PATH', () => {
    process.env.IMAP_MCP_DATABASE_PATH = '${HOME}/.imap-mcp-pro/data.db';
    const r = resolveEnvPlaceholders();
    expect(r.expanded).toContain('IMAP_MCP_DATABASE_PATH');
    expect(process.env.IMAP_MCP_DATABASE_PATH).toBe(`${os.homedir()}/.imap-mcp-pro/data.db`);
  });

  it('expands ${USER} as well', () => {
    process.env.IMAP_MCP_TEST_FAKE = '/srv/${USER}/data';
    const r = resolveEnvPlaceholders();
    expect(r.expanded).toContain('IMAP_MCP_TEST_FAKE');
    expect(process.env.IMAP_MCP_TEST_FAKE).toBe(`/srv/${os.userInfo().username}/data`);
  });

  it('leaves a well-formed value untouched', () => {
    process.env.IMAP_MCP_LOG_LEVEL = 'INFO';
    const r = resolveEnvPlaceholders();
    expect(r.expanded).not.toContain('IMAP_MCP_LOG_LEVEL');
    expect(r.cleared).not.toContain('IMAP_MCP_LOG_LEVEL');
    expect(process.env.IMAP_MCP_LOG_LEVEL).toBe('INFO');
  });
});

describe('resolveEnvPlaceholders — clear unsubstituted ${user_config.X}', () => {
  beforeEach(snapshotEnv);
  afterEach(restoreEnv);

  it('clears IMAP_MCP_ALLOWED_ATTACHMENT_DIRS when value is the literal placeholder', () => {
    process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS = '${user_config.allowed_attachment_dirs}';
    const r = resolveEnvPlaceholders();
    // Cleared from env. Note: a recovery path may then repopulate from a
    // real settings JSON if one happens to exist on the test host — so we
    // assert on the cleared bookkeeping, not the final env value. The final
    // value is whatever recovery produced (possibly unset, possibly real
    // dirs from the host's saved settings).
    expect(r.cleared).toContain('IMAP_MCP_ALLOWED_ATTACHMENT_DIRS');
    const finalValue = process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS;
    if (finalValue !== undefined) {
      expect(finalValue).not.toContain('${');
    }
  });

  it('clears any IMAP_MCP_* env that still contains a generic ${...} placeholder after expansion', () => {
    process.env.IMAP_MCP_TEST_FAKE = '${weird.placeholder}';
    const r = resolveEnvPlaceholders();
    expect(r.cleared).toContain('IMAP_MCP_TEST_FAKE');
    expect(process.env.IMAP_MCP_TEST_FAKE).toBeUndefined();
  });
});

describe('resolveEnvPlaceholders — array recovery from settings JSON', () => {
  let tmpHome: string;
  let restoreHomeFn: () => void;

  beforeEach(() => {
    snapshotEnv();
    // Create an isolated fake home with a Claude Desktop settings file.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'env-resolver-test-'));
    const settingsDir = path.join(tmpHome, 'Library', 'Application Support', 'Claude', 'Claude Extensions Settings');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'local.mcpb.test-author.imap-mcp-pro.json'),
      JSON.stringify({
        isEnabled: true,
        userConfig: {
          allowed_attachment_dirs: ['/tmp', '~/Downloads'],
        },
      }),
    );
    // Spoof os.homedir() for the duration of this test.
    const origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
    restoreHomeFn = () => { (os as any).homedir = origHomedir; };
  });

  afterEach(() => {
    restoreHomeFn();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    restoreEnv();
  });

  it('recovers IMAP_MCP_ALLOWED_ATTACHMENT_DIRS from settings JSON when env is unset, only on darwin', () => {
    delete process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS;
    const r = resolveEnvPlaceholders();
    if (process.platform === 'darwin') {
      expect(r.recoveredFromSettings).toContain('IMAP_MCP_ALLOWED_ATTACHMENT_DIRS');
      const expanded = (process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS ?? '').split(',');
      expect(expanded).toContain('/tmp');
      // Tilde-prefixed entries get expanded against the spoofed home.
      expect(expanded.some(d => d === path.join(tmpHome, 'Downloads'))).toBe(true);
    } else {
      // On other platforms our spoofed dir layout lives at the wrong
      // candidate path; recovery should be a no-op rather than crashing.
      expect(r.recoveredFromSettings).not.toContain('IMAP_MCP_ALLOWED_ATTACHMENT_DIRS');
    }
  });

  it('does not overwrite a well-formed env value', () => {
    process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS = '/explicit/path';
    const r = resolveEnvPlaceholders();
    expect(r.recoveredFromSettings).not.toContain('IMAP_MCP_ALLOWED_ATTACHMENT_DIRS');
    expect(process.env.IMAP_MCP_ALLOWED_ATTACHMENT_DIRS).toBe('/explicit/path');
  });
});
