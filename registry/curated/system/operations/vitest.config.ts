import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The hooks' tests are .tsx files under a jsdom environment of their own (a comment at their top).
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
