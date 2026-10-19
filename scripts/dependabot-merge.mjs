#!/usr/bin/env node
/**
 * Prints the decision of .github/workflows/dependabot-auto-merge.yml as JSON
 * ({land, label, comment, pr, reason}), from the API responses the workflow
 * saved:
 *
 *   node scripts/dependabot-merge.mjs <dir> <owner/repo> <head-sha>
 *
 * <dir> holds pulls.json, commits.json, message.txt, threads.json, checks.json
 * and timeline.json (the pull request's timeline, read for its last push, the
 * landing label's changes and the workflow's comments; an empty list when
 * absent). The decision itself is decideLanding in dependabot-merge-lib.mjs,
 * made at the time the script runs. The workflow labels and comments; it never
 * merges.
 *
 *   node scripts/dependabot-merge.mjs --owns-label <timeline.json>
 *
 * Prints true when the landing label is still the workflow's in a timeline it
 * read again just before taking the label off (workflowOwnsLabel), else false.
 */
import fs from 'node:fs';
import path from 'node:path';

import { decideLanding, workflowOwnsLabel } from './dependabot-merge-lib.mjs';

const args = process.argv.slice(2);
if (args[0] === '--owns-label' && args[1]) {
  console.log(String(workflowOwnsLabel(JSON.parse(fs.readFileSync(args[1], 'utf8')))));
} else {
  const [dir, repo, headSha] = args;
  if (!dir || !repo || !headSha) {
    console.error(
      'usage: node scripts/dependabot-merge.mjs <dir> <owner/repo> <head-sha>\n' +
        '       node scripts/dependabot-merge.mjs --owns-label <timeline.json>',
    );
    process.exit(2);
  }

  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
  const decision = decideLanding({
    repo,
    headSha,
    pulls: JSON.parse(read('pulls.json')),
    commits: JSON.parse(read('commits.json')),
    message: read('message.txt'),
    threads: JSON.parse(read('threads.json')),
    checkRuns: JSON.parse(read('checks.json')),
    timeline: fs.existsSync(path.join(dir, 'timeline.json')) ? JSON.parse(read('timeline.json')) : [],
    now: Date.now(),
  });
  console.log(JSON.stringify(decision));
}
