import { defineConfig } from 'vitest/config';

// No alias: `@framers/agentos` resolves to the release the override in pnpm-workspace.yaml installs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    testTimeout: 20000,
  },
});
