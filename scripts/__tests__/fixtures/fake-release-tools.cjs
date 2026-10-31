'use strict';
// A stand-in for npm, git and gh in the release job's publish and tags cases (release-plan.test.mjs, the 13 and 14
// cases). Every call is recorded in calls.jsonl in FAKE_RELEASE_DIR, in the order the tools ran; the wrapper on PATH
// passes the tool it stands for as the first argument. A call it does not know fails, so a call the step should not
// make fails the case.
//
// npm publish <tarball>: the package and version are read from the expected.json beside the tarball; it exits as
// scenario.npmExit['<name>@<version>'] says (0 by default), and a success adds <name>@<version> to published.txt, which
// the tests' registry reads, so the version's document answers from then on.
//
// git: push fails the first scenario.pushFailures times (a busy remote) and otherwise goes to the bare repository
// REMOTE_DIR in place of the address it names, as ls-remote and fetch do, so the remote's tags are real refs; but
// ls-remote <address> refs/heads/master answers scenario.tip when it is set, or scenario.tipAfter.tip once
// scenario.tipAfter.published is in published.txt. Every other subcommand runs the real git, REAL_GIT, as it is.
//
// gh release view <tag>: "false" (not a draft) for a tag in scenario.releases or one created earlier, "true" for one in
// scenario.drafts, else "release not found" and exit 1. gh release create <tag>: refused under --verify-tag when
// REMOTE_DIR holds no such tag (gh reads the remote repository, not the clone), else exits as
// scenario.createExit['<tag>'] says; the notes file's text is recorded with the call.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = process.env.FAKE_RELEASE_DIR;
const remote = process.env.REMOTE_DIR;
const realGit = process.env.REAL_GIT;
const [tool, ...args] = process.argv.slice(2);
const file = (name) => path.join(dir, name);
const scenario = fs.existsSync(file('scenario.json')) ? JSON.parse(fs.readFileSync(file('scenario.json'), 'utf8')) : {};
const lines = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name), 'utf8').split('\n').filter(Boolean) : []);
const calls = () => lines('calls.jsonl').map((line) => JSON.parse(line));
const record = (more = {}) => fs.appendFileSync(file('calls.jsonl'), `${JSON.stringify({ tool, args, cwd: process.cwd(), ...more })}\n`);

/** Ends the call with an exit status and what it prints. */
function finish(status, stdout = '', stderr = '') {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = status;
}

/** Runs the real git with these arguments, its output passed through, and ends with its exit status. */
function real(argv) {
  const result = spawnSync(realGit, argv, { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}

/** The remote's address in a git call: the token address the step builds, or any other https address. */
const ADDRESS = /^https:\/\//;

function npm() {
  record();
  if (args[0] !== 'publish' || args.length < 2) return finish(1, '', `npm: the fake knows no call ${args.join(' ')}\n`);
  const tarball = args[1];
  const expectedFile = path.join(path.dirname(tarball), 'expected.json');
  const expected = fs.existsSync(expectedFile) ? JSON.parse(fs.readFileSync(expectedFile, 'utf8')) : { tarballs: [] };
  const listed = expected.tarballs.find((entry) => entry.file === path.basename(tarball));
  if (!listed || !fs.existsSync(tarball)) return finish(1, '', `npm error ${tarball}: no such tarball\n`);
  const id = `${listed.name}@${listed.version}`;
  const code = scenario.npmExit?.[id] ?? 0;
  if (code !== 0) return finish(code, '', `npm error publish ${id} failed\n`);
  fs.appendFileSync(file('published.txt'), `${id}\n`);
  return finish(0, `+ ${id}\n`);
}

function git() {
  // The subcommand: the first argument after git's own options (-c <name>=<value> and -C <dir> take one more).
  let at = 0;
  while (at < args.length && args[at].startsWith('-')) at += args[at] === '-c' || args[at] === '-C' ? 2 : 1;
  const sub = args[at] ?? null;
  record({ sub });
  const local = args.map((arg) => (ADDRESS.test(arg) ? remote : arg));
  if (sub === 'push') {
    const pushes = calls().filter((call) => call.tool === 'git' && call.sub === 'push').length;
    if (pushes <= (scenario.pushFailures ?? 0)) {
      return finish(1, '', 'remote: the repository is too busy, try again later\nerror: failed to push some refs\n');
    }
    return real(local);
  }
  if (sub === 'ls-remote' && args.includes('refs/heads/master') && (scenario.tip || scenario.tipAfter)) {
    const moved = scenario.tipAfter && lines('published.txt').includes(scenario.tipAfter.published);
    return finish(0, `${moved ? scenario.tipAfter.tip : scenario.tip}\trefs/heads/master\n`);
  }
  if (sub === 'ls-remote' || sub === 'fetch') return real(local);
  return real(args);
}

function gh() {
  const notesAt = args.indexOf('--notes-file');
  const notes = notesAt === -1 ? null : fs.readFileSync(args[notesAt + 1], 'utf8');
  const answer = (status, stdout = '', stderr = '') => {
    record({ status, notes });
    finish(status, stdout, stderr);
  };
  const tag = args[2];
  if (args[0] === 'release' && args[1] === 'view' && tag) {
    const created = calls().some((call) => call.tool === 'gh' && call.args[1] === 'create' && call.args[2] === tag && call.status === 0);
    if ((scenario.releases ?? []).includes(tag) || created) return answer(0, 'false\n');
    if ((scenario.drafts ?? []).includes(tag)) return answer(0, 'true\n');
    return answer(1, '', 'release not found\n');
  }
  if (args[0] === 'release' && args[1] === 'create' && tag) {
    const onRemote = spawnSync(realGit, ['--git-dir', remote, 'rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0;
    if (args.includes('--verify-tag') && !onRemote) {
      return answer(1, '', `tag ${tag} doesn't exist in the repo ${process.env.GITHUB_REPOSITORY}, aborting due to --verify-tag flag\n`);
    }
    const code = scenario.createExit?.[tag] ?? 0;
    if (code !== 0) return answer(code, '', 'HTTP 422: Validation Failed\n');
    return answer(0, `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/tag/${encodeURIComponent(tag)}\n`);
  }
  return answer(1, '', `gh: the fake knows no call ${args.join(' ')}\n`);
}

if (tool === 'npm') npm();
else if (tool === 'git') git();
else if (tool === 'gh') gh();
else finish(1, '', `the fake knows no tool ${tool}\n`);
