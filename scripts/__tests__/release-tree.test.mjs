import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isBreaking, listPackages } from '../release-plan.mjs';

// The tree after the cut-over to release on every push to master (RELEASING.md). scripts/release-plan.mjs decides
// what a push publishes from npm and the release tags, so the Changesets CLI, its configuration, its pending files
// and its version step's manifest sync leave the repository. registry.json is a build output that the root package
// ships and git does not track. A pull request's title becomes its squash commit's subject, which the release reads
// for a breaking mark, so a check refuses a title outside the Conventional Commits form. The guides describe the
// plan, and each publishable package's CHANGELOG.md, which no tarball ships, points at the GitHub releases, the
// record of every version from then on.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const RELEASES = 'https://github.com/framerslab/agentos-extensions/releases';
const TITLE_WORKFLOW = path.join(root, '.github', 'workflows', 'pr-title.yml');

// GitHub's Ubuntu runners carry mikefarah's yq, which reads a workflow as GitHub reads it; elsewhere the cases that
// read the workflow's structure are skipped without it rather than failing on a missing tool.
const yqMissing = spawnSync('yq', ['--version']).error !== undefined;
const skip = yqMissing && !process.env.CI ? 'yq is not installed' : false;

/** The title workflow as yq reads it, anchors expanded. */
function titleWorkflow() {
  const parsed = spawnSync('yq', ['--output-format=json', '--indent=0', 'explode(.)', TITLE_WORKFLOW], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}

test('no .changeset directory: no Changesets configuration and no pending changeset', () => {
  assert.equal(fs.existsSync(path.join(root, '.changeset')), false, '.changeset exists');
});

test('package.json has no Changesets script and depends on no @changesets package', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(
    ['changeset', 'version-packages', 'release'].filter((key) => key in (pkg.scripts ?? {})),
    [],
    'package.json keeps a Changesets script',
  );
  const fields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  assert.deepEqual(
    fields.flatMap((field) => Object.keys(pkg[field] ?? {}).filter((name) => name.startsWith('@changesets/'))),
    [],
    'package.json depends on a @changesets package',
  );
});

test("the lockfile's root importer lists no @changesets package", () => {
  // pnpm-lock.yaml comes from lockfile.yml's run on the branch (an install never runs on a developer's machine); a
  // root importer still naming the Changesets packages is a lockfile that was not resolved again.
  const lines = read('pnpm-lock.yaml').split(/\r?\n/);
  const importers = lines.indexOf('importers:');
  const start = lines.indexOf('  .:', importers);
  assert.ok(importers !== -1 && start !== -1, 'pnpm-lock.yaml has no root importer');
  const end = lines.findIndex((line, at) => at > start && /^ {0,2}\S/.test(line));
  const block = lines.slice(start + 1, end === -1 ? undefined : end);
  assert.deepEqual(
    block.filter((line) => line.includes("'@changesets/")),
    [],
  );
});

test("the version step's pieces are gone: apply raises each planned manifest itself", () => {
  // scripts/release-plan.mjs apply carries sync-manifest-versions.mjs's logic (release-plan.test.mjs, 11b, 11e, 11f).
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'sync-manifest-versions.mjs')), false, 'scripts/sync-manifest-versions.mjs exists');
  assert.equal(fs.existsSync(path.join(here, 'version-step-leaves-registry.test.mjs')), false, 'version-step-leaves-registry.test.mjs exists');
});

test('registry.json is a build output: git tracks no copy and ignores the root one', () => {
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const tracked = git('ls-files', '--', 'registry.json');
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout.trim(), '', 'git tracks registry.json');
  assert.ok(read('.gitignore').split(/\r?\n/).includes('/registry.json'), '.gitignore has no /registry.json line');
  const ignored = git('check-ignore', '--no-index', '--quiet', 'registry.json');
  assert.equal(ignored.status, 0, `git does not ignore registry.json: ${ignored.stderr}`);
});

test('the pull request title workflow exists', () => {
  assert.ok(fs.existsSync(TITLE_WORKFLOW), '.github/workflows/pr-title.yml does not exist');
});

test('pr-title.yml runs job title, named "Pull request title", on every title change, with read-only permissions', { skip }, () => {
  const workflow = titleWorkflow();
  assert.equal(workflow.name, 'Pull request title');
  // A YAML 1.1 reader takes the key on for true, as .github/scripts/check-workflow-pushes.mjs allows.
  const on = 'on' in workflow ? workflow.on : workflow.true;
  assert.deepEqual(on, { pull_request: { types: ['opened', 'edited', 'synchronize', 'reopened'] } });
  assert.deepEqual(workflow.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['title']);
  assert.equal(workflow.jobs.title.name, 'Pull request title');
  assert.equal(workflow.jobs.title['runs-on'], 'ubuntu-latest');
});

test('the title check passes a title in the form and refuses one outside it, reading the title from the API', { skip }, (t) => {
  // The step runs as GitHub runs a step with no shell named (bash -e), with a stand-in gh that answers the one call
  // it makes, the pull request's title.
  const step = titleWorkflow().jobs.title.steps.find((candidate) => candidate.name === 'Refuse a title the release cannot read');
  assert.ok(step, 'the title job has no step "Refuse a title the release cannot read"');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-title-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'gh'),
    '#!/usr/bin/env bash\n' +
      '[ "$*" = "api repos/$REPO/pulls/$PR --jq .title" ] || { echo "unexpected gh call: $*" >&2; exit 2; }\n' +
      "printf '%s\\n' \"$FAKE_TITLE\"\n",
    { mode: 0o755 },
  );
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, step.run);
  const check = (title) =>
    spawnSync('bash', ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: [bin, process.env.PATH].join(path.delimiter), GH_TOKEN: 'a-token', REPO: 'framerslab/agentos-extensions', PR: '423', FAKE_TITLE: title },
    });

  for (const title of [
    'ci: release on every push to master, with no version or registry pull request',
    'feat(meeting-browser)!: the bot leaves a meeting its host ended',
    'fix(github, google-drive): a revoked token moves the sync to the next account',
  ]) {
    const result = check(title);
    assert.equal(result.status, 0, `${title}: ${result.stdout}${result.stderr}`);
  }
  for (const title of ['Land two idle pull requests in one batch: #31, #28 (#35)', 'Fix the outline', 'feat:no space', 'feature: an unknown type']) {
    const result = check(title);
    assert.equal(result.status, 1, `${title} passed: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /::error::The pull request title is not in the Conventional Commits form/);
  }
});

test('pr-title.yml plans the merge again on every event, an edit of the title or the description included', { skip }, () => {
  // ci.yml runs when a pull request is opened or pushed to, not when its title or description is edited, and the squash
  // merge carries them as they are when it lands: a `!` added after CI's last run would merge without the major a 1.x
  // package needs (release-plan case 1h) and leave master's run refusing it. The required check runs on every edit.
  const steps = titleWorkflow().jobs.title.steps;
  const at = (predicate) => steps.findIndex(predicate);
  const title = at((step) => step.name === 'Refuse a title the release cannot read');
  const checkout = at((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  const node = at((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/setup-node@'));
  const guard = at((step) => typeof step.run === 'string' && step.run.includes('release-plan.mjs plan'));
  assert.ok(title >= 0 && checkout > title && node > checkout && guard > node, `steps out of order: ${JSON.stringify(steps.map((step) => step.name ?? step.uses))}`);
  assert.equal(steps[checkout].with?.['fetch-depth'], 0, 'the plan reads the whole history and the tags');
  assert.equal(String(steps[node].with?.['node-version']), '22');
  assert.equal(steps[guard].name, 'The release accepts the title and the description');
});

test('the plan step writes the squash message as ci.yml does, from the title and the description as they are now, then plans and applies', { skip }, (t) => {
  const step = titleWorkflow().jobs.title.steps.find((candidate) => typeof candidate.run === 'string' && candidate.run.includes('release-plan.mjs plan'));
  assert.ok(step, 'no step plans the merge');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-title-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // A stand-in gh answers the two reads of the pull request; a stand-in node records each run of the release script.
  fs.writeFileSync(
    path.join(bin, 'gh'),
    '#!/usr/bin/env bash\n' +
      'case "$*" in\n' +
      '  "api repos/$REPO/pulls/$PR --jq .title") printf \'%s\\n\' "$FAKE_TITLE" ;;\n' +
      '  "api repos/$REPO/pulls/$PR --jq .body // \\"\\"") printf \'%s\\n\' "$FAKE_BODY" ;;\n' +
      '  *) echo "unexpected gh call: $*" >&2; exit 2 ;;\n' +
      'esac\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, 'node'), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$RUNNER_TEMP/node.log"\n', { mode: 0o755 });
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, step.run);
  const body = 'The description, as the squash merge will carry it.\n\nA second paragraph.';
  const result = spawnSync('bash', ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH].join(path.delimiter),
      GH_TOKEN: 'a-token',
      REPO: 'framerslab/agentos-extensions',
      PR: '472',
      RUNNER_TEMP: dir,
      FAKE_TITLE: 'feat(google-drive)!: rename the search tool',
      FAKE_BODY: body,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const message = path.join(dir, 'release-message.txt');
  assert.equal(fs.readFileSync(message, 'utf8'), `feat(google-drive)!: rename the search tool (#472)\n\n${body}\n`);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'node.log'), 'utf8').trim().split('\n'), [
    `scripts/release-plan.mjs plan --dry-run --message-file ${message}`,
    'scripts/release-plan.mjs apply',
  ]);
});

test('the pull request template asks for no changeset, names the breaking mark and npm trust, and marks no breaking change itself', () => {
  const template = read('.github/PULL_REQUEST_TEMPLATE.md');
  const lines = template.split(/\r?\n/);
  assert.deepEqual(lines.filter((line) => /changeset/i.test(line)), [], 'the template asks for a changeset');
  assert.ok(lines.some((line) => line.includes('BREAKING CHANGE') && line.includes('minor')), 'no line names BREAKING CHANGE and the minor it makes');
  assert.ok(lines.some((line) => line.includes('npm trust')), 'no line names npm trust');
  // Under the PR_BODY squash setting the template's text is every squash commit's body, and the plan reads a message
  // whole: a line beginning BREAKING CHANGE: or BREAKING-CHANGE: would make every merge a minor.
  assert.deepEqual(lines.filter((line) => /^BREAKING[ -]CHANGE:/.test(line)), [], 'a line of the template begins with the breaking mark');
  assert.equal(isBreaking(`docs: a change\n\n${template}`), false, 'the template reads as a breaking mark');
});

const POINTER = /^Releases (?:after (\d+\.\d+\.\d+) )?are (?:recorded at|published from) /;

/** What the pointer case refuses in the CHANGELOG.md text of the package `name`, or null when it accepts the file. */
function changelogProblem(text, name) {
  const lines = text.split(/\r?\n/);
  const title = lines.findIndex((line) => line.startsWith('# '));
  const pointers = lines.filter((line) => POINTER.test(line));
  const next = lines.slice(title + 1).find((line) => line.trim() !== '');
  // The file's top version, the first `## x.y.z` heading's; undefined when it has none.
  const top = /^## (\d+\.\d+\.\d+)/.exec(lines.find((line) => /^## \d+\.\d+\.\d+/.test(line)) ?? '')?.[1];
  const named = pointers.length === 1 ? POINTER.exec(pointers[0])[1] : undefined;
  if (title === -1) return 'no title heading';
  if (pointers.length !== 1) return `${pointers.length} pointer lines`;
  if (next !== pointers[0]) return 'the pointer line is not the first line under the title';
  if (named !== top) return `the pointer names ${named ?? 'no version'}, the top version is ${top ?? 'none'}`;
  if (!pointers[0].includes(RELEASES)) return `the pointer does not name ${RELEASES}`;
  if (pointers[0].includes(' are recorded at ') && !pointers[0].includes(`\`${name}@<version>\``)) return `the pointer does not name the tag ${name}@<version>`;
  return null;
}

test("each publishable package's CHANGELOG.md has one line under its title pointing at the GitHub releases from its top version", () => {
  const packages = listPackages(root);
  assert.ok(packages.length > 0, 'listPackages found no package');
  const wrong = [];
  for (const { dir, name } of packages) {
    const file = path.posix.join(dir, 'CHANGELOG.md');
    const problem = fs.existsSync(path.join(root, file)) ? changelogProblem(read(file), name) : 'missing';
    if (problem !== null) wrong.push(`${file}: ${problem}`);
  }
  assert.deepEqual(wrong, [], `${wrong.length} of ${packages.length} CHANGELOG.md files`);
});

test('the guides give a new pack a CHANGELOG.md of its own, which the case above accepts', () => {
  // A new pack starts as a copy of templates/basic-tool (CONTRIBUTING.md, AGENTS.md, README.md). The copy's
  // CHANGELOG.md holds the template's title, versions and tag, which the case above refuses under any other name, so
  // RELEASING.md gives the file a new pack holds instead, and each guide that copies the template says to replace it.
  const name = '@framers/agentos-ext-sample';
  assert.notEqual(changelogProblem(read('templates/basic-tool/CHANGELOG.md'), name), null, "the template's CHANGELOG.md passes as another package's");
  const given = /^```markdown\n(# @framers\/agentos-ext-<name>\n[\s\S]*?)^```$/m.exec(read('RELEASING.md'))?.[1];
  assert.ok(given, 'RELEASING.md gives no CHANGELOG.md for a new pack: no ```markdown block beginning # @framers/agentos-ext-<name>');
  const problem = changelogProblem(given.replaceAll('<name>', 'sample'), name);
  assert.equal(problem, null, `RELEASING.md's CHANGELOG.md for a new pack is refused: ${problem}`);
  for (const file of ['CONTRIBUTING.md', 'AGENTS.md', 'README.md']) {
    // Each list item, and each block between blank lines, that copies the template.
    const copies = read(file)
      .split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.)[ \t])/)
      .filter((part) => /cp -r templates\/basic-tool|a copy of `templates\/basic-tool`/.test(part));
    assert.ok(copies.length > 0, `${file} no longer copies templates/basic-tool: read this case again`);
    for (const part of copies) {
      assert.match(part, /CHANGELOG\.md/, `${file} copies templates/basic-tool and says nothing of the copy's CHANGELOG.md`);
    }
  }
});

test('RELEASING.md describes the release plan and none of the Changesets steps', () => {
  const guide = read('RELEASING.md');
  assert.match(guide, /release-plan\.mjs/);
  for (const gone of ['pnpm changeset', 'changesets/action', 'version-packages', '.changeset/']) {
    assert.equal(guide.includes(gone), false, `RELEASING.md names ${gone}`);
  }
  assert.doesNotMatch(guide, /version packages/i, 'RELEASING.md names the version pull request');
});

test('README.md, CONTRIBUTING.md and AGENTS.md ask for no changeset and name no version pull request', () => {
  for (const file of ['README.md', 'CONTRIBUTING.md', 'AGENTS.md']) {
    const text = read(file);
    assert.equal(text.includes('pnpm changeset'), false, `${file} names pnpm changeset`);
    assert.doesNotMatch(text, /version packages/i, `${file} names the version pull request`);
    assert.doesNotMatch(text, /changesets do\b/i, `${file} says changesets decide releases`);
    assert.doesNotMatch(text, /\.changeset\//, `${file} names .changeset/`);
  }
  assert.match(read('README.md'), /registry\.json +# generated by pnpm run build/, "README.md's tree does not call registry.json generated");
});

test("CONTRIBUTING.md's and AGENTS.md's CI steps plan the release and guard the planned packages", () => {
  for (const file of ['CONTRIBUTING.md', 'AGENTS.md']) {
    const text = read(file);
    assert.match(text, /node scripts\/release-plan\.mjs plan/, `${file} lists no release plan step`);
    assert.match(text, /node scripts\/pack-guard\.mjs --only [^\n]*--tarballs/, `${file} lists the pack guard without --only and --tarballs`);
  }
});

test("the push check's header names the release job's tag push and no registry step that opens a pull request", () => {
  const header = read('.github/scripts/check-workflow-pushes.mjs')
    .split('\n')
    .slice(0, 40)
    .map((line) => line.replace(/^\s*(\/\/|\/\*\*|\*\/|\*)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
  const sentences = header.split(/(?<=[.:;])\s+/);
  assert.deepEqual(sentences.filter((sentence) => /registry/i.test(sentence) && /pull request/i.test(sentence)), []);
  assert.match(header, /release-plan\.mjs tags/, 'the header does not name the release job\'s tag push');
});
