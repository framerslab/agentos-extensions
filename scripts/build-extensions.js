#!/usr/bin/env node
/**
 * Compiles TypeScript for extension packages that have their own tsconfig.json.
 * Only builds extensions whose src/ has been modified more recently than dist/.
 * A package that fails to compile prints the compiler's diagnostics and makes
 * the run exit 1, so CI and the release job stop instead of passing green
 * with a pack that has no build output.
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

const extensions = findExtensionDirs(registryDir);
let built = 0;
const failed = [];
/** Diagnostics shown per failed package; the rest are counted, not printed. */
const MAX_DIAGNOSTIC_LINES = 40;

for (const ext of extensions) {
  const srcTime = newestMtime(join(ext, 'src'));
  const distTime = newestMtime(join(ext, 'dist'));

  if (srcTime > distTime) {
    const label = relative(registryDir, ext);
    process.stdout.write(`  Building ${label}...`);
    try {
      execSync('npx tsc', { cwd: ext, stdio: 'pipe' });
      console.log(' ✓');
      built++;
    } catch (err) {
      console.log(' ✗');
      // tsc writes its diagnostics to stdout, so keep both streams.
      const output = `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim() || err.message;
      const lines = output.split('\n');
      for (const line of lines.slice(0, MAX_DIAGNOSTIC_LINES)) console.error(`    ${line}`);
      if (lines.length > MAX_DIAGNOSTIC_LINES) {
        console.error(`    ... ${lines.length - MAX_DIAGNOSTIC_LINES} more lines`);
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
  process.exit(1);
}
