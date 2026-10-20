// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Prototype-pollution guard on config deepMerge (#300; companion to the setPath guard from #206).
import { describe, expect, it } from 'vitest';
import { deepMerge } from './loader.js';

describe('deepMerge prototype-pollution guard (#300)', () => {
  it('skips __proto__ / constructor / prototype keys at the top level', () => {
    const src = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":{"x":1},"ok":1}');
    const dest: any = {};
    deepMerge(dest, src);
    expect(({} as any).polluted).toBeUndefined();
    expect(dest.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(dest, '__proto__')).toBe(false);
    expect(dest.ok).toBe(1);
  });

  it('skips the keys at any depth and still merges siblings', () => {
    const src = JSON.parse('{"a":{"b":{"__proto__":{"polluted":true},"keep":2}}}');
    const dest: any = { a: { b: { existing: 1 } } };
    deepMerge(dest, src);
    expect(({} as any).polluted).toBeUndefined();
    expect(dest.a.b).toEqual({ existing: 1, keep: 2 });
  });

  it('keeps normal merge semantics: arrays replace, objects recurse, scalars overwrite', () => {
    const dest: any = { arr: [1], obj: { x: 1, y: 1 }, s: 'a' };
    deepMerge(dest, { arr: [2, 3], obj: { y: 2 }, s: 'b', n: null });
    expect(dest).toEqual({ arr: [2, 3], obj: { x: 1, y: 2 }, s: 'b', n: null });
  });
});
