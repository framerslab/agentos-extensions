// The nightly real-join check's `--identity` arguments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readArguments } from '../../registry/curated/meetings/browser/image/test/nightly/arguments.mjs';

const PLATFORMS = ['google_meet', 'microsoft_teams'];

test('reads no identity as one run naming none', () => {
  assert.deepEqual(readArguments([], PLATFORMS), { platform: undefined, identities: [undefined] });
  assert.deepEqual(readArguments(['--platform', 'google_meet'], PLATFORMS), { platform: 'google_meet', identities: [undefined] });
});

test('reads each --identity in order, one run each', () => {
  assert.deepEqual(readArguments(['--platform', 'google_meet', '--identity', 'notes1', '--identity', 'notes1-x'], PLATFORMS), { platform: 'google_meet', identities: ['notes1', 'notes1-x'] });
});

test('refuses an unknown platform, an identity outside the folder-name form, a name given twice and an unknown option', () => {
  assert.throws(() => readArguments(['--platform', 'zoom'], PLATFORMS), /there is no platform zoom/);
  assert.throws(() => readArguments(['--identity', 'Notes 1'], PLATFORMS), /folder name/);
  assert.throws(() => readArguments(['--identity', 'notes1', '--identity', 'notes1'], PLATFORMS), /named once/);
  assert.throws(() => readArguments(['--meeting', 'x'], PLATFORMS));
});
