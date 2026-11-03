import { defineConfig } from 'vitest/config';

/** Runs the pack's suites against the built workspace packages; the PostgreSQL suite skips without its database. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 20000,
  },
});
