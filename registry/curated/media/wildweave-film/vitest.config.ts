import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    // Packs before any test file starts: prepack rewrites dist, which the bin tests' processes import.
    globalSetup: ['./test/global-setup.ts'],
  },
});
