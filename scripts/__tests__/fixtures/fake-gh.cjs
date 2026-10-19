'use strict';
// A stand-in for the gh CLI in the workflow tests: it records each call in
// calls.jsonl in FAKE_GH_DIR and answers from the scenario's files there,
// filtered through jq as gh's --jq filters. A call it does not know fails, so
// a call the workflow should not make, such as `gh pr merge`, fails the run.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? null : args[at + 1];
};
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const exists = (name) => fs.existsSync(path.join(dir, name));

// The flags of the calls the workflow makes that take a value.
const VALUED = new Set(['-X', '--method', '--jq', '-q', '-f', '-F', '--raw-field', '--field', '--input', '-H', '--header', '-R', '--repo', '--state', '--author', '--limit', '--json']);
const positional = [];
for (let at = 0; at < args.length; at += 1) {
  if (VALUED.has(args[at])) {
    at += 1;
  } else if (!args[at].startsWith('-')) {
    positional.push(args[at]);
  }
}
const method = valueOf('-X') ?? 'GET';
const endpoint =
  positional[0] === 'api' ? String(positional[1]).replace(`repos/${process.env.REPO}/`, '') : positional.slice(0, 2).join(' ');
const input = valueOf('--input') === '-' ? fs.readFileSync(0, 'utf8') : null;
fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ method, endpoint, args, input })}\n`);

function answer(body) {
  const filter = valueOf('--jq');
  if (filter === null) {
    if (!args.includes('--silent')) process.stdout.write(`${JSON.stringify(body)}\n`);
    process.exit(0);
  }
  const run = spawnSync('jq', ['-r', filter], { input: JSON.stringify(body), encoding: 'utf8' });
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  process.exit(run.status ?? 1);
}

function refuse(message) {
  process.stderr.write(`gh: ${message}\n`);
  process.exit(1);
}

const route = `${method} ${endpoint}`;
let match;
if (route === 'GET pr list') {
  answer(read('pr-list.json'));
} else if ((match = /^GET commits\/([0-9a-f]{40})\/pulls$/.exec(route))) {
  answer(read('pulls.json').filter((pull) => pull.head.sha === match[1]));
} else if ((match = /^GET commits\/([0-9a-f]{40})\/check-runs\?per_page=100$/.exec(route))) {
  answer({ total_count: read('checks.json').length, check_runs: read('checks.json') });
} else if ((match = /^GET commits\/([0-9a-f]{40})$/.exec(route))) {
  answer({ sha: match[1], commit: { message: fs.readFileSync(path.join(dir, 'message.txt'), 'utf8') } });
} else if (/^GET pulls\/\d+$/.test(route)) {
  answer(read('pull.json'));
} else if (/^GET pulls\/\d+\/commits\?per_page=100$/.test(route)) {
  answer(read('commits.json'));
} else if (route === 'GET graphql') {
  answer({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: read('threads.json') } } } } });
} else if (/^GET issues\/\d+\/timeline\?per_page=100$/.test(route)) {
  answer(read('timeline.json'));
} else if ((match = /^GET labels\/([^/]+)$/.exec(route))) {
  if (!read('repo-labels.json').includes(decodeURIComponent(match[1]))) refuse('Not Found (HTTP 404)');
  answer({ name: decodeURIComponent(match[1]) });
} else if (route === 'POST labels') {
  answer({ name: valueOf('-f') });
} else if (/^POST issues\/\d+\/comments$/.test(route)) {
  answer({ id: 1 });
} else if (/^POST issues\/\d+\/labels$/.test(route)) {
  answer([]);
} else if (/^DELETE issues\/\d+\/labels\/[^/]+$/.test(route)) {
  if (exists('label-gone')) refuse('Label does not exist (HTTP 404)');
  answer([]);
} else {
  refuse(`unexpected call: gh ${args.join(' ')}`);
}
