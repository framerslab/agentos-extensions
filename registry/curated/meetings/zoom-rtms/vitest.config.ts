import { defineConfig } from 'vitest/config';

// The worker's cases wait on a fake Zoom's handshake and on files the worker writes, each wait ending the moment its
// check holds; the bounds are wide so a loaded runner never cuts a wait that would have ended (test/fake-zoom.ts).
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
