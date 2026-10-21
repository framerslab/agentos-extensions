/**
 * Writes the two package.json files the parser's image installs from; the Dockerfile's build stage runs it, so the
 * image builds with npm alone from the pack's own pins and the workspace's lockfile:
 *
 * - `<compile>/package.json`: the compiler's, with the pack's own `typescript` and `@types/node` and the
 *   `@framers/agentos` release that pnpm-lock.yaml resolves for the pack, the release its tests run against;
 * - `<runtime>/package.json`: the parser's, with that `@framers/agentos` release and the pack's own dependencies.
 *
 * It refuses a lockfile that resolves no release for the pack (a missing importer, a linked core), a release below
 * the pack's peer floor, and a dependency of the pack that only the workspace holds.
 *
 * Usage: node manifests.mjs <the pack's package.json> <pnpm-lock.yaml> <compile folder> <runtime folder>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The pack's importer in pnpm-lock.yaml. */
const IMPORTER = 'registry/curated/tools/document-parser';
/** A release on npm: a version without a link, a path or the peers pnpm appends. */
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const [packFile, lockFile, compileDir, runtimeDir] = process.argv.slice(2);
if (!runtimeDir) throw new Error('usage: node manifests.mjs <package.json> <pnpm-lock.yaml> <compile folder> <runtime folder>');

/**
 * The version pnpm-lock.yaml resolves for `name` in the pack's importer: the `version:` line under the dependency's
 * key, without the peer suffix pnpm appends (`0.14.25(typescript@5.4.5)` is 0.14.25).
 */
function locked(lock, name) {
  const lines = lock.split('\n');
  const start = lines.indexOf(`  ${IMPORTER}:`);
  if (start < 0) throw new Error(`pnpm-lock.yaml has no importer ${IMPORTER}`);
  const key = `      '${name}':`;
  // The importer's lines are indented four spaces or more; a blank line, then the next importer, ends it.
  for (let i = start + 1; i < lines.length && lines[i].startsWith('    '); i += 1) {
    if (lines[i] !== key) continue;
    for (let j = i + 1; j < lines.length && lines[j].startsWith('        '); j += 1) {
      const match = /^ {8}version: ([^(\s]+)/.exec(lines[j]);
      if (!match) continue;
      if (!RELEASE.test(match[1])) throw new Error(`pnpm-lock.yaml resolves ${name} for ${IMPORTER} to ${match[1]}, not a release on npm`);
      return match[1];
    }
  }
  throw new Error(`pnpm-lock.yaml resolves no ${name} for ${IMPORTER}`);
}

/** Whether `version` is at or above the floor of a `>=x.y.z` range. */
function atOrAbove(version, range) {
  const floor = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!floor) throw new Error(`the pack's @framers/agentos peer range is ${range}, not a floor`);
  const have = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let k = 0; k < 3; k += 1) {
    const want = Number(floor[k + 1]);
    if (have[k] !== want) return have[k] > want;
  }
  return true;
}

function write(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const pack = JSON.parse(readFileSync(packFile, 'utf8'));
const agentos = locked(readFileSync(lockFile, 'utf8'), '@framers/agentos');
const floor = pack.peerDependencies?.['@framers/agentos'];
if (typeof floor !== 'string') throw new Error("the pack declares no @framers/agentos peer");
if (!atOrAbove(agentos, floor)) throw new Error(`pnpm-lock.yaml resolves @framers/agentos ${agentos}, below the pack's peer floor ${floor}`);

const dependencies = { ...(pack.dependencies ?? {}) };
for (const [name, spec] of Object.entries(dependencies)) {
  if (String(spec).startsWith('workspace:')) throw new Error(`the pack depends on ${name} at ${spec}; the image installs from npm`);
}
dependencies['@framers/agentos'] = agentos;

for (const tool of ['typescript', '@types/node']) {
  if (typeof pack.devDependencies?.[tool] !== 'string') throw new Error(`the pack pins no ${tool}`);
}
write(compileDir, {
  name: 'agentos-document-parser-compile',
  private: true,
  type: 'module',
  devDependencies: { typescript: pack.devDependencies.typescript, '@types/node': pack.devDependencies['@types/node'], '@framers/agentos': agentos },
});
write(runtimeDir, { name: 'agentos-document-parser-runtime', private: true, type: 'module', dependencies });
console.log(`@framers/agentos ${agentos}: the release pnpm-lock.yaml resolves for the pack (its peer floor ${floor})`);
