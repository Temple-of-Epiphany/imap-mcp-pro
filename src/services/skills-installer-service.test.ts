/**
 * Tests for skills-installer-service.ts internal helpers.
 *
 * Coverage: compareSemver.
 *
 * The install() method itself is exercised end-to-end by
 * scripts/smoke-test-skills-install.ts (5 scenarios: fresh, no-op,
 * upgrade, preserve-newer, skip-flag) which writes to a real tmpdir
 * and verifies on-disk state. That's higher fidelity than mocking fs.
 */

import { describe, expect, it } from 'vitest';
import { compareSemver } from './skills-installer-service.js';

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns negative when a is older (patch)', () => {
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
  });

  it('returns positive when a is newer (patch)', () => {
    expect(compareSemver('1.0.2', '1.0.1')).toBeGreaterThan(0);
  });

  it('returns negative when a is older (minor)', () => {
    expect(compareSemver('1.0.5', '1.1.0')).toBeLessThan(0);
  });

  it('returns positive when a is newer (major)', () => {
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('handles missing patch by treating it as 0', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
  });

  it('handles non-numeric parts by treating them as 0', () => {
    // MVP: no real prerelease handling. Documented limitation.
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(0);
  });

  it('orders the v0.1.0 -> v0.1.1 case the installer relies on', () => {
    // This is the actual scenario from v2.17.1: bundled v0.1.1 should
    // overwrite an on-disk v0.1.0.
    expect(compareSemver('0.1.1', '0.1.0')).toBeGreaterThan(0);
  });
});
