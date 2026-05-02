/**
 * Tests for package-info.ts.
 *
 * Single source of truth for the project's name + version is package.json.
 * These tests verify the utility resolves correctly at module load —
 * regression guard against the v2.6.0 hardcoded-string bug fixed in 2.17.1.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

describe('package-info', () => {
  it('exposes a non-empty PACKAGE_NAME', () => {
    expect(PACKAGE_NAME).toBeTruthy();
    expect(typeof PACKAGE_NAME).toBe('string');
  });

  it('exposes a non-empty PACKAGE_VERSION', () => {
    expect(PACKAGE_VERSION).toBeTruthy();
    expect(typeof PACKAGE_VERSION).toBe('string');
  });

  it('PACKAGE_NAME matches package.json name', () => {
    expect(PACKAGE_NAME).toBe(pkg.name);
  });

  it('PACKAGE_VERSION matches package.json version', () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it('PACKAGE_VERSION is a valid semver-shaped string', () => {
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
