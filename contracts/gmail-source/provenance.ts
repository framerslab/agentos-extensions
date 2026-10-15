import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, isAbsolute } from 'node:path';
const require = createRequire(import.meta.url);
const base = realpathSync(process.cwd());
// The account-sources and Gmail entry points are exported for `import` only, which `require.resolve` never matches;
// their exported package manifests locate the same installed roots.
const specs = [
  ['@framers/agentos', '@framers/agentos/cognition/rag', process.env.CORE_VERSION],
  ['@framers/agentos-ext-account-sources', '@framers/agentos-ext-account-sources/package.json', process.env.AS_VERSION],
  ['@framers/sql-storage-adapter', '@framers/sql-storage-adapter', process.env.ADAPTER_VERSION],
  ['@framers/agentos-ext-gmail-source', '@framers/agentos-ext-gmail-source/package.json', process.env.GMAIL_VERSION],
] as const;
function rootOf(entry: string, name: string): string {
  let directory = dirname(realpathSync(entry));
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return directory;
    const parent = dirname(directory); assert.notEqual(parent, directory, 'package_root_missing'); directory = parent;
  }
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
};
const roots = new Map<string, string>();
const records: Array<{ name: string; version: string; resolved: string; integrity: string; gitHead: string | null }> = [];
for (const [name, specifier, version] of specs) {
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  const root = rootOf(require.resolve(specifier), name); roots.set(name, root);
  const location = relative(base, root);
  assert.equal(isAbsolute(location), false); assert.equal(location.startsWith('..'), false);
  assert.equal(location.replaceAll('\\', '/'), `node_modules/${name}`);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version);
  const installed = lock.packages[`node_modules/${name}`]; assert.ok(installed);
  assert.equal(installed.link, undefined); assert.equal(installed.version, version);
  assert.match(installed.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//); assert.ok(installed.integrity);
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`);
  assert.equal(response.status, 200, 'immutable_registry_version_unavailable');
  const metadata = await response.json() as {
    name: string; version: string; gitHead?: string; dist: { integrity?: string; tarball?: string };
  };
  assert.equal(metadata.name, name); assert.equal(metadata.version, version);
  assert.equal(metadata.dist.integrity, installed.integrity); assert.equal(metadata.dist.tarball, installed.resolved);
  records.push({ name, version: version!, resolved: installed.resolved!, integrity: installed.integrity!, gitHead: metadata.gitHead ?? null });
}
for (const importer of ['@framers/agentos-ext-gmail-source', '@framers/agentos-ext-account-sources']) {
  const local = createRequire(require.resolve(`${importer}/package.json`));
  assert.equal(rootOf(local.resolve('@framers/agentos/cognition/library'), '@framers/agentos'), roots.get('@framers/agentos'));
  assert.equal(rootOf(local.resolve('@framers/agentos-ext-account-sources/package.json'), '@framers/agentos-ext-account-sources'),
    roots.get('@framers/agentos-ext-account-sources'));
  assert.equal(rootOf(local.resolve('@framers/sql-storage-adapter'), '@framers/sql-storage-adapter'), roots.get('@framers/sql-storage-adapter'));
}
const core = createRequire(require.resolve('@framers/agentos/cognition/rag'));
assert.equal(rootOf(core.resolve('@framers/sql-storage-adapter'), '@framers/sql-storage-adapter'), roots.get('@framers/sql-storage-adapter'));
const declared = JSON.parse(readFileSync(join(roots.get('@framers/agentos-ext-gmail-source')!, 'manifest.json'), 'utf8')) as {
  extensions: Array<{ kind: string }>;
};
assert.deepEqual(declared.extensions.map((extension) => extension.kind), ['library'], 'gmail_pack_declares_no_tool');
const pack = await import('@framers/agentos-ext-gmail-source');
const action = /send|reply|draft|compose|modify|trash|delete|insert|import/i;
assert.deepEqual(Object.keys(pack).filter((name) => action.test(name)), [], 'gmail_pack_exports_no_mail_action');
assert.deepEqual(Object.getOwnPropertyNames(pack.GmailApi.prototype).filter((name) => action.test(name)), [], 'gmail_api_has_no_mail_action');
writeFileSync('registry-evidence.json', JSON.stringify({ repository: process.env.GITHUB_REPOSITORY,
  workflowSha: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  node: process.version, records }, null, 2) + '\n');
