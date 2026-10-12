import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKS = ['image-generation', 'image-editing', 'vision-pipeline'];

// The image packs save to and read from one images directory, so they carry
// one imageFiles.ts. A change to its checks in one copy and not the others
// would let one pack read a file another pack refuses.
test('the image packs carry the same imageFiles.ts', () => {
  const copies = PACKS.map((pack) => {
    const file = path.join('registry', 'curated', 'tools', pack, 'src', 'imageFiles.ts');
    return { file, text: fs.readFileSync(path.join(root, file), 'utf8') };
  });
  for (const copy of copies.slice(1)) {
    assert.equal(copy.text, copies[0].text, `${copy.file} differs from ${copies[0].file}: change all three together`);
  }
});
