import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build-extensions.js');

/**
 * A repository of one pack in a folder of its own, the build script copied in beside its registry as the repository
 * holds it. The pack's own build writes dist and then fails while a file named `fail` sits in its folder, as a build of
 * several steps whose first step wrote dist and whose later step failed.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-extensions-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(script, path.join(root, 'scripts', 'build-extensions.js'));
  const pack = path.join(root, 'registry', 'curated', 'system', 'fixture');
  fs.mkdirSync(path.join(pack, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pack, 'tsconfig.json'), '{}\n');
  fs.writeFileSync(
    path.join(pack, 'build.mjs'),
    [
      "import fs from 'node:fs';",
      "fs.mkdirSync('dist', { recursive: true });",
      "fs.writeFileSync('dist/index.js', 'export {};\\n');",
      "if (fs.existsSync('fail')) process.exit(1);",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(pack, 'package.json'), `${JSON.stringify({ name: 'fixture', private: true, type: 'module', scripts: { build: 'node build.mjs' } }, null, 2)}\n`);
  const source = path.join(pack, 'src', 'index.ts');
  fs.writeFileSync(source, 'export {};\n');
  // The source is older than anything a build writes.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(source, past, past);
  fs.writeFileSync(path.join(pack, 'fail'), '');
  return { root, pack };
}

/** One run of the copied script as a person runs it locally, outside CI, where it builds only what looks out of date. */
function run(root) {
  const env = { ...process.env };
  delete env.CI;
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-extensions.js')], { cwd: root, env, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a build that failed after writing dist is built again on the next run, until a build passes', () => {
  const { root, pack } = fixture();
  try {
    const first = run(root);
    assert.equal(first.status, 1, first.out);
    assert.match(first.out, /Building system\/fixture\.\.\. ✗/);
    // The failed build left dist newer than src, which alone would read as up to date.
    assert.ok(fs.existsSync(path.join(pack, 'dist', 'index.js')));
    assert.ok(fs.existsSync(path.join(pack, '.build-failed')));

    const second = run(root);
    assert.equal(second.status, 1, second.out);
    assert.match(second.out, /Building system\/fixture\.\.\. ✗/);
    assert.doesNotMatch(second.out, /Extensions up to date/);

    fs.rmSync(path.join(pack, 'fail'));
    const third = run(root);
    assert.equal(third.status, 0, third.out);
    assert.match(third.out, /Building system\/fixture\.\.\. ✓/);
    assert.ok(!fs.existsSync(path.join(pack, '.build-failed')));

    const fourth = run(root);
    assert.equal(fourth.status, 0, fourth.out);
    assert.match(fourth.out, /Extensions up to date/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
