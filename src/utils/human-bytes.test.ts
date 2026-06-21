// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from 'vitest';
import { humanBytes } from './human-bytes.js';

describe('humanBytes', () => {
  it('renders sub-KB as whole bytes', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(1023)).toBe('1023 B');
  });

  it('steps adaptively through KB/MB/GB/TB', () => {
    expect(humanBytes(1024)).toBe('1.00 KB');
    expect(humanBytes(10 * 1024)).toBe('10.00 KB');
    expect(humanBytes(10 * 1024 * 1024)).toBe('10.00 MB');
    expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
    expect(humanBytes(3 * 1024 ** 4)).toBe('3.00 TB');
  });

  it('does not surface raw byte counts for large values', () => {
    expect(humanBytes(10_000_000_000)).toBe('9.31 GB');
    expect(humanBytes(10_000_000_000)).not.toMatch(/\d{6,} B/);
  });

  it('clamps invalid/negative input to 0 B', () => {
    expect(humanBytes(-5)).toBe('0 B');
    expect(humanBytes(NaN)).toBe('0 B');
    expect(humanBytes(Infinity)).toBe('0 B');
  });
});
