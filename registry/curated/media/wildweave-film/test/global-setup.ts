/**
 * Packs once, before any test file starts, and hands the listing to `packed-files.test.ts`.
 *
 * `npm pack` runs `prepack`, which runs `tsc` over `dist`. Test files run in parallel, so a pack inside a test file
 * rewrites `dist` while `bin.test.ts` and `mcp.test.ts` start processes that import it, and a process that reads a file
 * `tsc` has just truncated dies on import: its client sees `Connection closed`.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The files `npm pack` would put in the tarball, sorted. */
    packedFiles: string[];
  }
}

export default function setup(project: TestProject): void {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts=false'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const listing = JSON.parse(out.slice(out.indexOf('['))) as Array<{ files: Array<{ path: string }> }>;
  project.provide('packedFiles', listing[0]!.files.map((f) => f.path).sort());
}
