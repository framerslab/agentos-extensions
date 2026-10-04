#!/usr/bin/env node

/**
 * Imports one package and checks the contract of its role. Runs as a child
 * process from the directory the package is installed in, so a bare package
 * name resolves the way it does for a consumer.
 *
 * Argument: one JSON object
 *   { module, role, secrets, options, exports }
 * `module` is a package name or a file URL.
 *
 * On success it prints one JSON line: `{ "descriptors": [ids] }` for a pack,
 * `{}` for the other roles.
 */

import net from 'node:net';

const input = JSON.parse(process.argv[2] ?? '{}');

/** Prints the reason and stops with a failing status. */
function fail(message) {
  console.error(message);
  process.exit(1);
}

// Loading and constructing a package must not reach the network: the inputs
// are placeholders, and a pack that connects here would do so in every agent
// that only lists it. `fetch` and TCP connections (which carry http, https,
// tls and websockets) are refused. Each attempt is recorded when it is made,
// so a pack that swallows the resulting error still fails the check.
const networkAttempts = [];
const BLOCKED = 'network access is blocked in the pack guard';
globalThis.fetch = async (resource) => {
  networkAttempts.push(`fetch ${String(resource?.url ?? resource)}`);
  throw new Error(BLOCKED);
};
net.Socket.prototype.connect = function connect(...args) {
  const target = args[0] && typeof args[0] === 'object' ? `${args[0].host ?? args[0].path ?? ''}:${args[0].port ?? ''}` : String(args[0]);
  networkAttempts.push(`connection to ${target}`);
  // The socket fails on the next tick, as a refused connection does, so the
  // caller's own error handling runs instead of an exception from `connect`.
  process.nextTick(() => this.destroy(new Error(BLOCKED)));
  return this;
};

/** The reason reported when a blocked connection surfaces as a stray error. */
function strayError(error) {
  if (networkAttempts.length > 0) return `reached for the network while loading or constructing: ${networkAttempts[0]}`;
  return `raised an error outside its factory: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
}
process.on('uncaughtException', (error) => fail(strayError(error)));
process.on('unhandledRejection', (error) => fail(strayError(error)));

const silent = { info() {}, warn() {}, error() {}, debug() {} };

let mod;
try {
  mod = await import(input.module);
} catch (error) {
  fail(`import failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
}

const report = {};
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
  report.descriptors = pack.descriptors.map((descriptor) => descriptor?.id);
} else if (input.role === 'library') {
  for (const name of input.exports ?? []) {
    if (typeof mod[name] !== 'function') fail(`does not export the function ${name}`);
  }
} else if (input.role === 'root') {
  if (!mod.default || typeof mod.default !== 'object') fail('default export is not the registry object');
} else {
  fail(`unknown role ${input.role}`);
}

if (networkAttempts.length > 0) {
  fail(`reached for the network while loading or constructing: ${networkAttempts[0]}`);
}

console.log(JSON.stringify(report));
// A constructed pack may hold timers open; the check is done.
process.exit(0);
