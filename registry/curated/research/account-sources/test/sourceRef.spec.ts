import { describe, expect, it } from 'vitest';
import { isSourceRef, lineRange, sourceRefLink, type SourceRef } from '../src/index.js';

const github: SourceRef = {
  kind: 'github',
  title: 'Guide',
  url: 'https://github.com/example/example/blob/fake-commit/docs/guide.md',
  version: 'fake-commit',
  readAt: '2026-10-08T12:00:00Z',
  path: 'docs/guide.md',
  lines: [2, 4],
};

/** Exercises line numbers from literal text offsets. */
describe('lineRange', () => {
  const text = 'one\ntwo\nthree\nfour';

  /** Finds a span wholly inside the third line. */
  it('finds a span inside line three', () => {
    expect(lineRange(text, 9, 12)).toEqual([3, 3]);
  });

  /** Finds the first and last lines of a multiline span. */
  it('finds a span across lines two to four', () => {
    expect(lineRange(text, 4, 16)).toEqual([2, 4]);
  });

  /** Includes the final character without needing a trailing newline. */
  it('finds a span at the end without a newline', () => {
    expect(lineRange(text, 17, 18)).toEqual([4, 4]);
  });

  /** Counts a carriage return and line feed as one break. */
  it('counts CRLF as one line break', () => {
    expect(lineRange('one\r\ntwo\r\nthree\r\nfour', 10, 15)).toEqual([3, 3]);
    expect(lineRange('one\r\ntwo\r\nthree\r\nfour', 5, 19)).toEqual([2, 4]);
  });

  /** Keeps an exclusive end at the next line out of the range. */
  it('treats the end offset as exclusive', () => {
    expect(lineRange(text, 4, 8)).toEqual([2, 2]);
  });

  /** Places an empty span on the line containing its start. */
  it('places empty spans at their start', () => {
    expect(lineRange('', 0, 0)).toEqual([1, 1]);
    expect(lineRange(text, 18, 18)).toEqual([4, 4]);
  });
});

/** Exercises links carried by the different source kinds. */
describe('sourceRefLink', () => {
  /** Adds the lines to the file address at its recorded commit. */
  it('links a GitHub file to its line range', () => {
    expect(sourceRefLink(github)).toBe('https://github.com/example/example/blob/fake-commit/docs/guide.md#L2-L4');
  });

  /** Uses a single anchor when both line numbers are equal. */
  it('links a single GitHub line', () => {
    expect(sourceRefLink({ ...github, lines: [3, 3] })).toBe('https://github.com/example/example/blob/fake-commit/docs/guide.md#L3');
  });

  /** Preserves an account file address including its fragment. */
  it('keeps a Drive address unchanged', () => {
    const url = 'https://drive.google.com/file/d/fake-file/view#section';
    expect(sourceRefLink({ ...github, kind: 'google_drive', url })).toBe(url);
  });

  /** Preserves a web page address including its fragment. */
  it('keeps a web page address unchanged', () => {
    const url = 'https://example.invalid/guide#intro';
    expect(sourceRefLink({ ...github, kind: 'web', url })).toBe(url);
  });

  /** Leaves absent addresses and absent line ranges alone. */
  it('handles sources without a link or line range', () => {
    expect(sourceRefLink({ ...github, kind: 'upload', url: null })).toBeNull();
    expect(sourceRefLink({ ...github, lines: undefined })).toBe(github.url);
  });
});

/** Exercises the reference guard at the boundary with unknown values. */
describe('isSourceRef', () => {
  /** Accepts each source kind and a later connector with the same shape. */
  it('accepts complete references', () => {
    expect(isSourceRef(github)).toBe(true);
    for (const kind of ['upload', 'web', 'dropbox', 'google_drive', 'future_connector']) {
      expect(isSourceRef({ kind, title: 'Example', url: null, version: null, readAt: '2026-10-08T12:00:00Z' })).toBe(true);
    }
  });

  /** Rejects references without the required identity fields. */
  it('refuses a missing kind or title', () => {
    expect(isSourceRef({ title: 'Guide', url: null, version: null, readAt: '2026-10-08T12:00:00Z' })).toBe(false);
    expect(isSourceRef({ kind: 'upload', url: null, version: null, readAt: '2026-10-08T12:00:00Z' })).toBe(false);
  });

  /** Rejects malformed attribution fields and invalid line tuples. */
  it('refuses malformed references', () => {
    for (const value of [null, [], 'Guide', {}, { ...github, url: 3 }, { ...github, version: undefined }, { ...github, readAt: 0 }, { ...github, path: null }, { ...github, lines: [0, 2] }, { ...github, lines: [4, 2] }, { ...github, lines: [1, 2, 3] }, { ...github, lines: [1.5, 2] }]) {
      expect(isSourceRef(value)).toBe(false);
    }
  });
});
