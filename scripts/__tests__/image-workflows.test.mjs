import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Two packs ship a container image: the meeting bot and the document parser. Their workflows build and test the
// image on every push to master that touches the pack and push it tagged with the commit, :sha-<seven characters>.
// The version's tag, :<version>, has one writer, the release workflow's images step (scripts/release-plan.mjs
// images), which copies the :sha- manifest of the commit a released version's directory was last changed at. So the
// image workflows read no version from master's package.json, which is not the released version, and push no
// version's tag. The role map's images key names each image pack, its image and its workflow.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const WORKFLOWS = path.join(root, '.github', 'workflows');
// GitHub's Ubuntu runners carry mikefarah's yq, which reads a workflow as GitHub reads it; elsewhere the checks that
// read a workflow's structure are skipped without it rather than failing on a missing tool.
const yqMissing = spawnSync('yq', ['--version']).error !== undefined;
const skip = yqMissing && !process.env.CI ? 'yq is not installed' : false;

const EXPECTED = {
  'registry/curated/meetings/browser': { image: 'ghcr.io/framerslab/agentos-meeting-bot', workflow: 'meeting-bot-image.yml' },
  'registry/curated/tools/document-parser': {
    image: 'ghcr.io/framerslab/agentos-document-parser',
    workflow: 'document-parser-image.yml',
  },
};

/**
 * A line that tags or pushes a version, or reads one from the pack's package.json: the bot's `:$V`, the parser's
 * `$image:$VERSION`, a job's version or release output, `node -p "require('./package.json').version"` and
 * `jq -r .version`.
 */
const VERSION_LINES = [
  /agentos-(meeting-bot|document-parser):\$(V|VERSION)\b/,
  /:\$\{?(V|VERSION)\b/,
  /outputs\.(version|release)\b/,
  /package\.json['"]?\)?\.version\b/,
  /jq\s+(-r\s+)?\.version\b/,
];

const roleMap = () => JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'package-roles.json'), 'utf8'));
const text = (workflow) => fs.readFileSync(path.join(WORKFLOWS, workflow), 'utf8');

/** The workflow as yq reads it, anchors expanded. */
function parsed(workflow) {
  const read = spawnSync('yq', ['--output-format=json', '--indent=0', 'explode(.)', path.join(WORKFLOWS, workflow)], {
    encoding: 'utf8',
  });
  assert.equal(read.status, 0, read.stderr);
  return JSON.parse(read.stdout);
}

test('the role map names the two image packs, their images and their workflows, and each workflow exists', () => {
  const map = roleMap();
  assert.deepEqual(map.images, EXPECTED);
  for (const [dir, { workflow }] of Object.entries(map.images)) {
    assert.ok(map.roles?.[dir], `${dir} has a role in scripts/package-roles.json`);
    assert.ok(fs.existsSync(path.join(root, dir, 'package.json')), `${dir}/package.json exists`);
    assert.ok(fs.existsSync(path.join(WORKFLOWS, workflow)), `.github/workflows/${workflow} exists`);
  }
});

test('neither image workflow pushes a version tag or reads a version for one', () => {
  for (const { workflow } of Object.values(EXPECTED)) {
    const found = text(workflow)
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => !line.trim().startsWith('#') && VERSION_LINES.some((pattern) => pattern.test(line)))
      .map(({ line, number }) => `${workflow}:${number}: ${line.trim()}`);
    assert.deepEqual(found, [], `${workflow} names a version tag or reads a version`);
  }
  assert.doesNotMatch(text('document-parser-image.yml'), /The pack's version, and whether this commit releases it/);
});

test("each image workflow pushes the commit's tag in the form the images step copies from", () => {
  // reconcileImages copies <image>:sha-<the image commit's first seven characters>; GITHUB_SHA is the pushed commit.
  for (const { image, workflow } of Object.values(EXPECTED)) {
    const body = text(workflow);
    assert.match(body, /sha-\$\{GITHUB_SHA::7\}/, `${workflow} tags the image sha-<seven characters of the commit>`);
    assert.ok(body.includes(image), `${workflow} pushes ${image}`);
  }
});

test('the parser workflow has no step that reads the version, and each image workflow runs on every push to master that touches its pack', { skip }, () => {
  for (const [dir, { workflow }] of Object.entries(EXPECTED)) {
    const spec = parsed(workflow);
    const steps = Object.values(spec.jobs ?? {}).flatMap((job) => (job.steps ?? []).map((step) => step.name ?? ''));
    assert.ok(!steps.includes("The pack's version, and whether this commit releases it"), `${workflow} has the version step`);
    for (const [id, job] of Object.entries(spec.jobs ?? {})) {
      assert.equal(job.outputs?.version, undefined, `${workflow} job ${id} has a version output`);
      assert.equal(job.outputs?.release, undefined, `${workflow} job ${id} has a release output`);
    }
    // The images step's image commit is the newest commit on master that touched the pack's directory, so a push of
    // that commit must have run this workflow. (A YAML 1.1 reader takes the key on for true, as
    // .github/scripts/check-workflow-pushes.mjs allows.)
    const on = 'on' in spec ? spec.on : spec.true;
    assert.deepEqual(on?.push?.branches, ['master'], `${workflow} runs on a push to master`);
    assert.ok(on?.push?.paths?.includes(`${dir}/**`), `${workflow} runs on a push that touches ${dir}`);
  }
});
