import { defineConfig } from 'vitest/config';

/** Runs the library's tests over fetch stand-ins for Notion's OAuth and API addresses. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 10_000,
  },
});
