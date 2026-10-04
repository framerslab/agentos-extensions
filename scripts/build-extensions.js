#!/usr/bin/env node
/**
 * Compiles TypeScript for extension packages that have their own tsconfig.json.
 * Locally, only builds extensions whose src/ is newer than dist/; in CI it
 * builds every extension.
 * A package that fails to compile prints the compiler's diagnostics and makes
 * the run exit 1, so CI and the release job stop instead of passing green
 * with a pack that has no build output. tsc runs with --noEmitOnError, so a
 * failed compile writes nothing: dist stays older than src and the package is
 * compiled again on the next run, and a committed dist is never removed.
 */
import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
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
      const full = join(dir, entry.name);
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

const extensions = findExtensionDirs(registryDir);
let built = 0;
const failed = [];
/** Diagnostics shown per failed package; the rest are counted, not printed. */
const MAX_DIAGNOSTIC_LINES = 40;

for (const ext of extensions) {
  const srcTime = newestMtime(join(ext, 'src'));
  const distTime = newestMtime(join(ext, 'dist'));

  // In CI every package is rebuilt: a checked-in or cached dist/ must not make
  // a fresh checkout look up to date.
  if (process.env.CI || srcTime > distTime) {
    const label = relative(registryDir, ext);
    process.stdout.write(`  Building ${label}...`);
    try {
      // The flag overrides a tsconfig that allows emit on error, so a failed
      // compile leaves dist exactly as it was.
      execSync('npx tsc --noEmitOnError', { cwd: ext, stdio: 'pipe' });
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
