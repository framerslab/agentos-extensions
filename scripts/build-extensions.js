#!/usr/bin/env node
/**
 * Compiles TypeScript for extension packages that have their own tsconfig.json.
 * Locally, only builds extensions whose src/ is newer than dist/; in CI it
 * builds every extension.
 * A package that fails to compile prints the compiler's diagnostics and makes
 * the run exit 1, so CI and the release job stop instead of passing green
 * with a pack that has no build output. tsc runs with --noEmitOnError, so a
 * failed compile writes nothing, and a committed dist is never removed.
 * A package whose own build script does more than tsc (a second config, a
 * stylesheet, generated files) runs that script instead, so CI builds and
 * tests what the package's own build makes. Such a script can fail after one
 * of its steps wrote dist, which then looks newer than src, so a failed build
 * leaves a .build-failed file in the package's folder (written before the
 * build starts, so a stopped build leaves it too): the next run builds that
 * package whatever the times say, and a build that passes removes it.
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const registryDir = join(__dirname, '..', 'registry', 'curated');

function findExtensionDirs(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(join(full, 'tsconfig.json')) && existsSync(join(full, 'src'))) {
      results.push(full);
    } else {
      // Recurse one level (e.g., channels/discord)
      for (const sub of readdirSync(full, { withFileTypes: true })) {
        const subFull = join(full, sub.name);
        if (sub.isDirectory() && existsSync(join(subFull, 'tsconfig.json')) && existsSync(join(subFull, 'src'))) {
          results.push(subFull);
        }
      }
    }
  }
  return results;
}

function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    try {
      // A recursive listing names each entry under its own folder (parentPath), not under dir.
      const full = join(entry.parentPath ?? entry.path ?? dir, entry.name);
      const st = statSync(full);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* skip */ }
  }
  return newest;
}

/**
 * Splits tsc output into diagnostics: a header line plus its indented
 * continuation lines.
 */
function diagnostics(output) {
  const groups = [];
  for (const line of output.split('\n')) {
    if (groups.length && /^\s/.test(line)) groups[groups.length - 1].push(line);
    else groups.push([line]);
  }
  return groups;
}

/**
 * Orders packages so that a workspace package compiles before every package
 * that depends on it. A pack that imports another pack resolves it through the
 * workspace link, whose entry points sit under dist/, so the dependency's
 * declarations must exist before the dependent's tsc runs. Packages with no
 * workspace dependencies keep their directory order; a dependency cycle fails
 * the run with the cycle named.
 */
function orderByWorkspaceDependencies(dirs) {
  const dirByName = new Map();
  const depsByDir = new Map();
  for (const dir of dirs) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      depsByDir.set(dir, []);
      continue;
    }
    if (typeof pkg.name === 'string') dirByName.set(pkg.name, dir);
    depsByDir.set(dir, Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    }));
  }
  const ordered = [];
  const state = new Map();
  const visit = (dir, trail) => {
    const seen = state.get(dir);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      const cycle = [...trail, dir].map((d) => relative(registryDir, d)).join(' -> ');
      throw new Error(`Workspace dependency cycle: ${cycle}`);
    }
    state.set(dir, 'visiting');
    for (const name of depsByDir.get(dir) ?? []) {
      const depDir = dirByName.get(name);
      if (depDir && depDir !== dir) visit(depDir, [...trail, dir]);
    }
    state.set(dir, 'done');
    ordered.push(dir);
  };
  for (const dir of dirs) visit(dir, []);
  return ordered;
}

/**
 * The command that builds a package: its own build script when that does more
 * than plain tsc, else tsc with --noEmitOnError. A package with no readable
 * package.json or no build script takes tsc.
 */
function buildCommand(dir) {
  let own;
  try {
    own = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.build;
  } catch {
    own = undefined;
  }
  const script = typeof own === 'string' ? own.trim() : '';
  return script !== '' && !/^tsc( -p tsconfig\.json)?$/.test(script) ? 'pnpm run build' : 'npx tsc --noEmitOnError';
}

const extensions = orderByWorkspaceDependencies(findExtensionDirs(registryDir));
let built = 0;
const failed = [];
/** Diagnostics shown per failed package; the rest are counted, not printed. */
const MAX_DIAGNOSTIC_LINES = 40;

/** The file a failed build leaves in its package's folder, so the next run builds the package again. */
const FAILED_MARKER = '.build-failed';

for (const ext of extensions) {
  const srcTime = newestMtime(join(ext, 'src'));
  const distTime = newestMtime(join(ext, 'dist'));
  const marker = join(ext, FAILED_MARKER);

  // In CI every package is rebuilt: a checked-in or cached dist/ must not make
  // a fresh checkout look up to date. Nor may a build that failed part way.
  if (process.env.CI || srcTime > distTime || existsSync(marker)) {
    const label = relative(registryDir, ext);
    process.stdout.write(`  Building ${label}...`);
    // The marker is written before the build and removed only when it passes,
    // so a build that fails or is stopped part way leaves it.
    writeFileSync(marker, '');
    try {
      // The flag overrides a tsconfig that allows emit on error, so a failed
      // compile leaves dist exactly as it was; a package's own build script
      // may write part of dist before it fails, which the marker covers.
      execSync(buildCommand(ext), { cwd: ext, stdio: 'pipe' });
      rmSync(marker, { force: true });
      console.log(' ✓');
      built++;
    } catch (err) {
      console.log(' ✗');
      // tsc writes its diagnostics to stdout, so keep both streams.
      const output = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim() || err.message;
      // The package's own errors first; errors inside dependencies' type
      // declarations (node_modules) after them. Array sort is stable.
      const groups = diagnostics(output);
      const inDependency = (group) => Number(/node_modules[\\/]/.test(group[0]));
      groups.sort((a, b) => inDependency(a) - inDependency(b));
      const dependencyErrors = groups.filter(inDependency).length;
      const lines = groups.flat();
      for (const line of lines.slice(0, MAX_DIAGNOSTIC_LINES)) console.error(`    ${line}`);
      if (lines.length > MAX_DIAGNOSTIC_LINES) {
        console.error(`    ... ${lines.length - MAX_DIAGNOSTIC_LINES} more lines`);
      }
      if (dependencyErrors > 0) {
        console.error(`    (${dependencyErrors} of these are in dependencies' type declarations; "skipLibCheck": true skips them)`);
      }
      failed.push(label);
    }
  }
}

if (built > 0) {
  console.log(`✅ Built ${built} extension(s)`);
} else if (failed.length === 0) {
  console.log('Extensions up to date');
}

if (failed.length > 0) {
  console.error(`❌ ${failed.length} extension(s) failed to compile: ${failed.join(', ')}`);
  // exitCode instead of exit(): the process ends after stderr has flushed.
  process.exitCode = 1;
}
