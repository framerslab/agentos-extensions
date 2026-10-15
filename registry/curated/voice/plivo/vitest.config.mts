import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'vitest/config';

// Vite resolves package exports with resolve.exports, which applies the core's
// multi-wildcard keys ("./*/*/*/*") by putting the whole subpath in place of every
// "*", so the deep import below maps to a file that does not exist. Node ignores
// those keys and resolves the specifier through "./*" to
// dist/io/channels/telephony/CallManager.js; the tests load that same file of the
// installed release.
const coreDist = dirname(createRequire(import.meta.url).resolve('@framers/agentos'));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@framers\/agentos\/io\/channels\/telephony\/CallManager$/,
        replacement: join(coreDist, 'io', 'channels', 'telephony', 'CallManager.js'),
      },
    ],
  },
});
