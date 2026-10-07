#!/usr/bin/env node
/**
 * Prints the merge decision of .github/workflows/dependabot-auto-merge.yml as
 * JSON ({merge, pr, reason}), from the API responses the workflow saved:
 *
 *   node scripts/dependabot-merge.mjs <dir> <owner/repo> <head-sha>
 *
 * <dir> holds pulls.json, commits.json, message.txt, threads.json and
 * checks.json. The decision itself is decideMerge in dependabot-merge-lib.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { decideMerge } from './dependabot-merge-lib.mjs';

const [dir, repo, headSha] = process.argv.slice(2);
if (!dir || !repo || !headSha) {
  console.error('usage: node scripts/dependabot-merge.mjs <dir> <owner/repo> <head-sha>');
  process.exit(2);
}

const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const decision = decideMerge({
  repo,
  headSha,
  pulls: JSON.parse(read('pulls.json')),
  commits: JSON.parse(read('commits.json')),
  message: read('message.txt'),
  threads: JSON.parse(read('threads.json')),
  checkRuns: JSON.parse(read('checks.json')),
});
console.log(JSON.stringify(decision));
