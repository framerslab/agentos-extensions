import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The words the package's public text never uses: whole words, any case, so `AgentOS` passes. */
const BANNED = /\b(?:ai|claude|opus|codex|agents?|models?|generated)\b/i;

const pack = new URL('../', import.meta.url);
const changesets = new URL('../../../../../.changeset/', import.meta.url);

/** The public text: the README, the manifest, the words, the CHANGELOG once changesets writes it, and the pack's pending changesets. */
function publicText(): Array<{ readonly file: string; readonly text: string }> {
  const files = [new URL('README.md', pack), new URL('manifest.json', pack), new URL('src/words.ts', pack)].map((url) => ({
    file: url.pathname,
    text: readFileSync(url, 'utf8'),
  }));
  const changelog = new URL('CHANGELOG.md', pack);
  if (existsSync(changelog)) files.push({ file: changelog.pathname, text: readFileSync(changelog, 'utf8') });
  if (existsSync(changesets)) {
    for (const name of readdirSync(changesets)) {
      if (!name.endsWith('.md') || name === 'README.md') continue;
      const url = new URL(name, changesets);
      const text = readFileSync(url, 'utf8');
      if (text.includes('"@framers/agentos-ext-operations"')) files.push({ file: url.pathname, text });
    }
  }
  return files;
}

describe('the public text', () => {
  it('the README, CHANGELOG, manifest, words and changesets hold none of the banned words', () => {
    const files = publicText();
    expect(files.map((entry) => entry.file.split('/').pop())).toEqual(expect.arrayContaining(['README.md', 'manifest.json', 'words.ts']));
    for (const { file, text } of files) {
      const hit = BANNED.exec(text);
      expect(hit?.[0] ?? null, `${file} uses a banned word`).toBeNull();
    }
  });
});
