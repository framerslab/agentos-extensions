#!/usr/bin/env node

/**
 * Imports one package and checks the contract of its role. Runs as a child
 * process from the directory the package is installed in, so a bare package
 * name resolves the way it does for a consumer.
 *
 * Argument: one JSON object
 *   { module, role, secrets, options, exports }
 * `module` is a package name or a file URL.
 */

const input = JSON.parse(process.argv[2] ?? '{}');

/** Prints the reason and stops with a failing status. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

// Construction must not reach the network; a pack that fetches here is wrong.
globalThis.fetch = async () => {
  throw new Error('network access is blocked in the pack guard');
};

const silent = { info() {}, warn() {}, error() {}, debug() {} };

let mod;
try {
  mod = await import(input.module);
} catch (error) {
  fail(`import failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
}

if (input.role === 'pack') {
  const factory = mod.createExtensionPack ?? mod.default?.createExtensionPack ?? mod.default;
  if (typeof factory !== 'function') fail('does not export createExtensionPack');
  const secrets = input.secrets ?? {};
  let pack;
  try {
    pack = await factory({
      options: { ...(input.options ?? {}), secrets },
      getSecret: (id) => secrets[id],
      logger: silent,
    });
  } catch (error) {
    fail(`createExtensionPack threw: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }
  if (!pack || !Array.isArray(pack.descriptors) || pack.descriptors.length === 0) {
    fail('createExtensionPack returned no descriptors');
  }
} else if (input.role === 'library') {
  for (const name of input.exports ?? []) {
    if (typeof mod[name] !== 'function') fail(`does not export the function ${name}`);
  }
} else if (input.role === 'root') {
  if (!mod.default || typeof mod.default !== 'object') fail('default export is not the registry object');
} else {
  fail(`unknown role ${input.role}`);
}

// A constructed pack may hold timers or sockets open; the check is done.
process.exit(0);
