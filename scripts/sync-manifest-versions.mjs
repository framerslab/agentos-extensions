#!/usr/bin/env node

/**
 * Raises each package's manifest.json version to its package.json version.
 *
 * `changeset version` bumps package.json only, so a release left the manifest
 * that ships in the tarball naming the previous version. This runs right after
 * it (the `version-packages` script), so the version pull request carries both.
 *
 * A manifest is only ever raised. One that names a higher version than its
 * package is reported and left alone: that package owes a release.
 *
 *   node scripts/sync-manifest-versions.mjs            # this repository
 *   node scripts/sync-manifest-versions.mjs --root <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listWorkspacePackages, manifestVersionAction } from './pack-guard-lib.mjs';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const repoRoot = rootFlag >= 0 ? path.resolve(args[rootFlag + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let raised = 0;
for (const { dir, pkg } of listWorkspacePackages(repoRoot)) {
  const file = path.join(repoRoot, dir, 'manifest.json');
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    console.error(`${dir}/manifest.json is not valid JSON: ${error.message}`);
    process.exitCode = 1;
    continue;
  }

  const action = manifestVersionAction(pkg.version, manifest.version);
  if (action === 'ahead') {
    console.log(`::warning file=${dir}/manifest.json::manifest.json says ${manifest.version} and package.json says ${pkg.version}; the package owes a release`);
    continue;
  }
  if (action !== 'raise') continue;

  // Replace the value in place so the file keeps its formatting and line
  // endings. If the first "version" key in the text is not the top-level one,
  // fall back to rewriting the document.
  let updated = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${pkg.version}$2`);
  if (JSON.parse(updated).version !== pkg.version) {
    updated = `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`;
  }
  fs.writeFileSync(file, updated);
  raised += 1;
  console.log(`${dir}: manifest ${manifest.version} -> ${pkg.version}`);
}
console.log(`manifest versions: ${raised} raised.`);
