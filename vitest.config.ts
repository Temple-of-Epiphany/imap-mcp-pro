/**
 * vitest configuration — picks up *.test.ts files colocated with sources
 * under src/. Excludes scripts/ (those are smoke tests run manually with
 * tsx against real accounts) and dist/ (built output).
 *
 * Run:
 *   npm test           — single-pass run, suitable for CI
 *   npm run test:watch — watch mode for local development
 *
 * Author: Colin Bitterfield
 * Date Created: 2026-05-01
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'scripts/**', 'archive/**'],
    // Reasonable defaults: no globals, native ESM, fast happy-path execution.
    globals: false,
    environment: 'node',
    reporters: ['default'],
  },
});
