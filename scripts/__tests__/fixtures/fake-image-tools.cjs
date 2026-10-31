'use strict';
// A stand-in for docker, gh and skopeo in the release images step's tests (release-plan.test.mjs, the 16 cases): a
// registry of image references and their digests in registry.json, the image workflows' runs from scenario.json, and
// every call recorded in calls.jsonl, all in FAKE_IMAGES_DIR. The wrapper on PATH passes the tool it stands for as the
// first argument. A call it does not know fails, so a call the step should not make fails the case.
//
// scenario.json: { registry: { <reference>: <digest> }, runs: { '<workflow>@<commit>': [<runs answered to the first
// read>, <to the second>, ...] }, copiedDigests: { <reference>: <digest a copy to it reads back> },
// inspectErrors: { <reference>: <what docker manifest inspect prints> },
// listErrors: { <image>: <what skopeo list-tags prints> } }. The last list of runs answers every read after it.
// skopeo list-tags docker://<image> answers as skopeo prints it: { Repository, Tags }, every tag the registry holds
// for the image.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.FAKE_IMAGES_DIR;
const [tool, ...args] = process.argv.slice(2);
const file = (name) => path.join(dir, name);
const scenario = JSON.parse(fs.readFileSync(file('scenario.json'), 'utf8'));
const registry = fs.existsSync(file('registry.json'))
  ? JSON.parse(fs.readFileSync(file('registry.json'), 'utf8'))
  : { ...(scenario.registry ?? {}) };
const earlier = fs
  .readFileSync(file('calls.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const stdin = args.includes('--password-stdin') ? fs.readFileSync(0, 'utf8') : null;
fs.appendFileSync(file('calls.jsonl'), `${JSON.stringify({ tool, args, stdin })}\n`);

/** The answer to this call: [exit status, standard output, standard error]. */
function answer() {
  const reference = args[args.length - 1];
  if (tool === 'docker') {
    if (args[0] === 'login' && args[1] === 'ghcr.io') return [0, 'Login Succeeded\n', ''];
    if (args[0] === 'manifest' && args[1] === 'inspect' && args.length === 3) {
      if (scenario.inspectErrors?.[reference]) return [1, '', `${scenario.inspectErrors[reference]}\n`];
      if (registry[reference]) return [0, `${JSON.stringify({ schemaVersion: 2, digest: registry[reference] })}\n`, ''];
      return [1, '', `no such manifest: ${reference}\n`];
    }
    if (args[0] === 'buildx' && args[1] === 'imagetools' && args[2] === 'create') {
      const target = args[args.indexOf('-t') + 1];
      if (!registry[reference]) return [1, '', `ERROR: ${reference}: not found\n`];
      registry[target] = scenario.copiedDigests?.[target] ?? registry[reference];
      fs.writeFileSync(file('registry.json'), JSON.stringify(registry));
      return [0, '', ''];
    }
    if (args[0] === 'buildx' && args[1] === 'imagetools' && args[2] === 'inspect') {
      if (!registry[reference]) return [1, '', `ERROR: ${reference}: not found\n`];
      return [0, `${JSON.stringify(registry[reference])}\n`, ''];
    }
  }
  if (tool === 'skopeo' && args[0] === 'list-tags' && args.length === 2 && args[1].startsWith('docker://')) {
    const image = args[1].slice('docker://'.length);
    if (scenario.listErrors?.[image]) return [1, '', `time="2026-10-28T12:00:00Z" level=fatal msg="${scenario.listErrors[image]}"\n`];
    const tags = Object.keys(registry)
      .filter((held) => held.startsWith(`${image}:`))
      .map((held) => held.slice(image.length + 1));
    return [0, `${JSON.stringify({ Repository: image, Tags: tags }, null, 4)}\n`, ''];
  }
  if (tool === 'gh' && args[0] === 'api' && args.length === 2) {
    const route = /^repos\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)\/runs\?head_sha=([0-9a-f]{40})&per_page=10$/.exec(args[1]);
    if (route) {
      const answers = scenario.runs?.[`${route[1]}@${route[2]}`] ?? [];
      const asked = earlier.filter((call) => call.tool === 'gh' && call.args[1] === args[1]).length;
      const runs = answers.length === 0 ? [] : answers[Math.min(asked, answers.length - 1)];
      return [0, `${JSON.stringify({ total_count: runs.length, workflow_runs: runs })}\n`, ''];
    }
  }
  return [1, '', `${tool}: the fake knows no call ${args.join(' ')}\n`];
}

const [status, stdout, stderr] = answer();
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = status;
