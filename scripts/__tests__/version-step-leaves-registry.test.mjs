import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scripts = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts;

// The registry records published versions only. The version pull request leaves it as it is and the release writes
// it after a publish: a version step that regenerated it would put versions on master that a failed or partial
// publish never sent to npm (the version pull request of 19 October 2026 carried gmail-source 0.6.0 that way).
test('the version step raises versions and manifests and leaves registry.json to the release that publishes', () => {
  assert.equal(scripts['version-packages'], 'changeset version && node scripts/sync-manifest-versions.mjs');
  assert.doesNotMatch(scripts['version-packages'], /update-registry/);
});
