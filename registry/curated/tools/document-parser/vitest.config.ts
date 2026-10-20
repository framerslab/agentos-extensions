import { defineConfig } from 'vitest/config';

/** Runs the parser's tests against the installed dependencies: the protocol, the reader and the server over a real socket. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        'test/',
        '*.config.ts'
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    },
    include: ['test/**/*.spec.ts'],
    testTimeout: 10000
  }
});
