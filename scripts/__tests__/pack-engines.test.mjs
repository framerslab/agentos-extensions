import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compareVersions, listWorkspacePackages } from '../pack-guard-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTOS = '@framers/agentos';

/**
 * The lowest Node version an engines range admits, as x.y.z: the lowest bound among its `||` alternatives, each a
 * version that may open with >=, ^ or ~ and may end in x or *. Any other range, such as `>=22 <24`, gives null.
 * @param {unknown} range
 * @returns {string | null}
 */
function nodeFloor(range) {
  if (typeof range !== 'string' || range.trim() === '') return null;
  const floors = [];
  for (const alternative of range.split('||')) {
    const match = /^(?:>=|\^|~)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(alternative.trim());
    if (!match) return null;
    const part = (value) => (value === undefined || value === 'x' || value === '*' ? '0' : value);
    floors.push(`${match[1]}.${part(match[2])}.${part(match[3])}`);
  }
  return floors.sort(compareVersions)[0];
}

/**
 * The engines.node that pnpm-lock.yaml records for each version of a package, read from the entries of its packages
 * section (`name@version`, with the engines field as a flow mapping); null for an entry with none.
 * @param {string} lockfile
 * @param {string} name
 * @returns {Map<string, string | null>}
 */
function lockedNodeRanges(lockfile, name) {
  const start = lockfile.indexOf('\npackages:\n');
  const end = lockfile.indexOf('\nsnapshots:\n');
  const section = start === -1 ? '' : lockfile.slice(start, end === -1 ? undefined : end);
  const ranges = new Map();
  for (const entry of section.split(/\n(?= {2}\S)/)) {
    const key = entry.split('\n')[0].trim().replace(/:$/, '').replace(/^'(.*)'$/, '$1');
    if (!key.startsWith(`${name}@`)) continue;
    const engines = /\n {4}engines: \{([^}\n]*)\}/.exec(entry);
    const node = engines && /(?:^|,)\s*node: (?:'([^']*)'|"([^"]*)"|([^,]+))/.exec(engines[1]);
    ranges.set(key.slice(name.length + 1), node ? (node[1] ?? node[2] ?? node[3].trim()) : null);
  }
  return ranges;
}

test('reads the lowest Node an engines range admits', () => {
  assert.equal(nodeFloor('>=22'), '22.0.0');
  assert.equal(nodeFloor('>=20.19.0'), '20.19.0');
  assert.equal(nodeFloor('^22.12.0 || ^20.19.0'), '20.19.0');
  assert.equal(nodeFloor('22.x'), '22.0.0');
  assert.equal(nodeFloor('>=22 <24'), null);
  assert.equal(nodeFloor(undefined), null);
});

// pnpm writes the packages section before the snapshots section; the reader finds it in either order.
test('reads the packages section of pnpm-lock.yaml wherever the snapshots section sits', () => {
  const entry = "  '@framers/agentos@0.14.25':\n    resolution: {integrity: sha512-fixture}\n    engines: {node: '>=22'}\n";
  const snapshots = "snapshots:\n\n  '@framers/agentos@0.14.25': {}\n";
  for (const lockfile of [
    `lockfileVersion: '9.0'\n\npackages:\n\n${entry}\n${snapshots}`,
    `lockfileVersion: '9.0'\n\n${snapshots}\npackages:\n\n${entry}`,
  ]) {
    assert.deepEqual([...lockedNodeRanges(lockfile, AGENTOS)], [['0.14.25', '>=22']]);
  }
});

// A pack's engines field names the Node releases it supports, and npm installs the pack with the @framers/agentos its
// peer range admits. Every agentos release from 0.10.35 on declares Node 22 or later, so a pack that names Node 20, or
// names no Node at all (npm then installs it on any release), installs there beside a core that does not support
// Node 20. The agentos this workspace builds and tests against is the one pnpm-lock.yaml resolves, and the lockfile
// records the engines field it declares. A pack that depends on another pack of this workspace names no Node that pack
// refuses either. An optional peer sets no floor: npm does not install it with the pack, which runs without it.
test('no pack admits a Node release that its @framers/agentos or a pack it depends on refuses', () => {
  const lockfile = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  const agentos = [...lockedNodeRanges(lockfile, AGENTOS)];
  assert.ok(agentos.length > 0, `pnpm-lock.yaml resolves no ${AGENTOS}: the check reads the wrong file`);
  assert.deepEqual(
    agentos.filter(([, range]) => nodeFloor(range) === null),
    [],
    `every ${AGENTOS} in pnpm-lock.yaml declares an engines.node this check reads`
  );
  const [agentosVersion, agentosRange] = agentos.reduce((highest, entry) =>
    compareVersions(nodeFloor(entry[1]), nodeFloor(highest[1])) > 0 ? entry : highest
  );
  const agentosFloor = nodeFloor(agentosRange);

  const packages = listWorkspacePackages(root);
  const declared = new Map(packages.map(({ pkg }) => [pkg.name, pkg.engines?.node]));
  const problems = [];
  let checked = 0;
  for (const { dir, pkg } of packages) {
    const range = pkg.engines?.node;
    const floor = range === undefined ? '0.0.0' : nodeFloor(range);
    if (floor === null) {
      problems.push(`${dir}: engines.node ${JSON.stringify(range)} is not a range this check reads`);
      continue;
    }
    checked += 1;
    const optional = Object.entries(pkg.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional === true)
      .map(([name]) => name);
    const runtime = Object.keys({ ...pkg.peerDependencies, ...pkg.dependencies }).filter(
      (name) => !optional.includes(name) || Object.hasOwn(pkg.dependencies ?? {}, name)
    );
    const admits =
      range === undefined
        ? 'declares no engines.node, so npm installs it on any Node'
        : `engines.node ${JSON.stringify(range)} admits Node ${floor}`;
    if (runtime.includes(AGENTOS) && compareVersions(floor, agentosFloor) < 0) {
      problems.push(`${dir}: ${admits}; ${AGENTOS} ${agentosVersion} needs ${agentosRange}`);
    }
    for (const name of runtime) {
      const theirs = nodeFloor(declared.get(name));
      if (theirs !== null && compareVersions(floor, theirs) < 0) {
        problems.push(`${dir}: ${admits}; ${name} needs ${declared.get(name)}`);
      }
    }
  }
  assert.ok(checked > 20, `checked only ${checked} packages; the walk is wrong`);
  assert.deepEqual(problems, []);
});
