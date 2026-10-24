/**
 * @fileoverview `parseGitHubLink` over the addresses a person pastes: a repository, a folder and a file on github.com and
 * a file on raw.githubusercontent.com, each with and without `.git`, a trailing slash, a fragment and a query, under
 * http, with a port and without a scheme; the GitHub addresses the pack does not read, each refused and never answered
 * as another site's; and the addresses of other hosts, which are not GitHub's.
 */

import { describe, expect, it } from 'vitest';
import { parseGitHubLink, type GitHubLink } from '../documents/index.js';

const COMMIT = '9f2c4e6a'.repeat(5);
const REPOSITORY: GitHubLink = { kind: 'github_repository', owner: 'acme-team', repo: 'handbook' };
const REFUSED: GitHubLink = { kind: 'refused' };

/** A folder of the handbook at `refAndPath`. */
function folder(refAndPath: string): GitHubLink {
  return { kind: 'github_folder', owner: 'acme-team', repo: 'handbook', refAndPath };
}

/** A file of the handbook at `refAndPath`, raw when the address served its bytes alone. */
function file(refAndPath: string, raw = false): GitHubLink {
  return { kind: 'github_file', owner: 'acme-team', repo: 'handbook', refAndPath, raw };
}

describe('parseGitHubLink', () => {
  it('reads a repository whatever its scheme, port, .git, trailing slash, query or fragment', () => {
    const forms = [
      'https://github.com/acme-team/handbook',
      'https://github.com/acme-team/handbook/',
      'https://github.com/acme-team/handbook.git',
      'https://github.com/acme-team/handbook.git/',
      'https://github.com/acme-team/handbook#readme',
      'https://github.com/acme-team/handbook?tab=readme-ov-file',
      'http://github.com/acme-team/handbook',
      'https://github.com:8443/acme-team/handbook',
      'https://www.github.com/acme-team/handbook',
      'HTTPS://GitHub.COM/acme-team/handbook',
      '  https://github.com/acme-team/handbook\n',
      'github.com/acme-team/handbook',
      'github.com:8443/acme-team/handbook/',
      '//github.com/acme-team/handbook',
      'git://github.com/acme-team/handbook.git',
      'ssh://git@github.com/acme-team/handbook.git',
      'git@github.com:acme-team/handbook.git',
      'https://github.com./acme-team/handbook',
    ];
    for (const form of forms) expect(parseGitHubLink(form), form).toEqual(REPOSITORY);
  });

  it("reads a folder's ref and path as one text, a branch's own slashes included, for the connector to settle", () => {
    const forms: Array<[string, GitHubLink]> = [
      ['https://github.com/acme-team/handbook/tree/release/1.0/docs', folder('release/1.0/docs')],
      ['https://github.com/acme-team/handbook/tree/release/1.0/docs/', folder('release/1.0/docs')],
      ['https://github.com/acme-team/handbook/tree/release/1.0/docs#top', folder('release/1.0/docs')],
      ['https://github.com/acme-team/handbook/tree/release/1.0/docs?plain=1', folder('release/1.0/docs')],
      ['http://github.com:80/acme-team/handbook/tree/main/docs', folder('main/docs')],
      ['github.com/acme-team/handbook/tree/main/docs', folder('main/docs')],
      ['https://github.com/acme-team/handbook.git/tree/main/docs', folder('main/docs')],
      ['https://github.com/acme-team/handbook/tree/main', folder('main')],
      // GitHub's own form of a branch by its full name, read as the branch.
      ['https://github.com/acme-team/handbook/tree/refs/heads/release/1.0/docs', folder('release/1.0/docs')],
      // Each segment decoded: a branch holding a "#", a folder holding a space.
      ['https://github.com/acme-team/handbook/tree/docs%231/guide%20one', folder('docs#1/guide one')],
      [`https://github.com/acme-team/handbook/tree/${COMMIT}/docs`, folder(`${COMMIT}/docs`)],
      // GitHub shows the folder for a blob address that names no path.
      ['https://github.com/acme-team/handbook/blob/main', folder('main')],
    ];
    for (const [form, link] of forms) expect(parseGitHubLink(form), form).toEqual(link);
  });

  it("reads a file on github.com and on raw.githubusercontent.com, GitHub's raw addresses marked raw", () => {
    const forms: Array<[string, GitHubLink]> = [
      ['https://github.com/acme-team/handbook/blob/main/docs/agenda.md', file('main/docs/agenda.md')],
      ['https://github.com/acme-team/handbook/blob/main/docs/agenda.md#L3-L4', file('main/docs/agenda.md')],
      ['https://github.com/acme-team/handbook/blob/main/docs/agenda.md?plain=1', file('main/docs/agenda.md')],
      ['http://www.github.com/acme-team/handbook/blob/main/docs/agenda.md', file('main/docs/agenda.md')],
      [`https://github.com/acme-team/handbook/blob/${COMMIT}/docs/agenda.md`, file(`${COMMIT}/docs/agenda.md`)],
      ['https://github.com/acme-team/handbook/blob/refs/heads/main/docs/agenda.md', file('main/docs/agenda.md')],
      ['https://github.com/acme-team/handbook/raw/main/docs/agenda.md', file('main/docs/agenda.md', true)],
      ['https://github.com/acme-team/handbook/raw/refs/heads/main/docs/agenda.md', file('main/docs/agenda.md', true)],
      ['https://raw.githubusercontent.com/acme-team/handbook/main/docs/agenda.md', file('main/docs/agenda.md', true)],
      ['https://raw.githubusercontent.com/acme-team/handbook/refs/heads/main/docs/agenda.md', file('main/docs/agenda.md', true)],
      ['http://raw.githubusercontent.com:8443/acme-team/handbook/main/README.md', file('main/README.md', true)],
      ['raw.githubusercontent.com/acme-team/handbook/main/README.md', file('main/README.md', true)],
    ];
    for (const [form, link] of forms) expect(parseGitHubLink(form), form).toEqual(link);
  });

  it('refuses a GitHub address that names no repository, folder or file the pack reads', () => {
    const forms = [
      'https://github.com/acme-team/handbook/issues/12',
      'https://github.com/acme-team/handbook/pull/3',
      'https://github.com/acme-team/handbook/pulls',
      'https://github.com/acme-team/handbook/wiki',
      'https://github.com/acme-team/handbook/wiki/Home',
      'https://github.com/acme-team/handbook/releases',
      'https://github.com/acme-team/handbook/releases/tag/v1.0',
      'https://github.com/acme-team/handbook/actions',
      `https://github.com/acme-team/handbook/commit/${COMMIT}`,
      'https://github.com/acme-team/handbook/compare/main...release',
      'https://github.com/acme-team/handbook/discussions/4',
      'https://github.com/acme-team/handbook/tree',
      'https://github.com/acme-team/handbook/blob',
      'https://github.com/acme-team/handbook/raw/main',
      'https://github.com/acme-team/handbook/tree/refs/tags/v1.0/docs',
      'https://github.com/acme-team/handbook/tree/refs/pull/3/head',
      'https://github.com/acme-team/handbook/tree/main//docs',
      'https://github.com/acme-team/handbook/tree/main/%2E%2E%2Fsecret',
      'https://github.com/acme-team/handbook/tree/main/a%00b',
      'https://github.com/acme-team/hand%ZZbook',
      'https://github.com/acme-team/hand%20book',
      'https://github.com/acme-team/.git',
      'https://github.com/-acme/handbook',
      'https://github.com/acme-team',
      'https://github.com',
      'https://github.com/',
      'https://github.com/settings/profile',
      'https://github.com/orgs/acme-team',
      'https://github.com/topics/python',
      'https://github.com/marketplace/actions',
      'https://github.com/sponsors/someone',
      'https://gist.github.com/someone/0123abcd',
      'https://api.github.com/repos/acme-team/handbook',
      'https://codeload.github.com/acme-team/handbook/zip/refs/heads/main',
      'https://gist.githubusercontent.com/someone/0123abcd/raw/notes.md',
      'https://objects.githubusercontent.com/github-production-release-asset/1',
      'https://raw.githubusercontent.com/acme-team/handbook',
      'https://raw.githubusercontent.com/acme-team/handbook/main',
      'https://ghp_secret@github.com/acme-team/handbook',
      'https://someone:secret@github.com/acme-team/handbook',
      'https://git:secret@github.com/acme-team/handbook',
      'someone@github.com:acme-team/handbook.git',
      'git@gist.github.com:0123abcd.git',
    ];
    for (const form of forms) expect(parseGitHubLink(form), form).toEqual(REFUSED);
  });

  it('answers a GitHub host as a GitHub form or refused, never as another site, whatever the scheme, port or path', () => {
    const hosts = ['github.com', 'www.github.com', 'gist.github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com'];
    for (const host of hosts) {
      for (const scheme of ['https://', 'http://', '']) {
        for (const port of ['', ':8080']) {
          for (const path of ['/', '/x', '/a/b/c/d/e/f', '/a/b/unknown/x', '/a/b?x=1#y']) {
            const form = `${scheme}${host}${port}${path}`;
            expect(parseGitHubLink(form), form).not.toBeNull();
          }
        }
      }
    }
  });

  it("answers null for an address that is not GitHub's, and for text that is no address", () => {
    const forms = [
      'https://example.com/acme-team/handbook',
      'https://docs.github.com/en/rest/git/refs',
      'https://acme-team.github.io/handbook/',
      'https://github.blog/changelog/',
      'https://notgithub.com/acme-team/handbook',
      'https://evilgithub.com/acme-team/handbook',
      'https://github.com.example.org/acme-team/handbook',
      'https://githubusercontent.com.example.org/acme-team/handbook',
      'https://drive.google.com/file/d/1AbC/view',
      'git@gitlab.com:acme-team/handbook.git',
      'mailto:someone@github.com',
      'javascript:alert(1)',
      'not a link',
      '',
      '   ',
    ];
    for (const form of forms) expect(parseGitHubLink(form), form).toBeNull();
  });

  it('refuses a value that is not text with a TypeError', () => {
    expect(() => parseGitHubLink(42 as unknown as string)).toThrow(TypeError);
    expect(() => parseGitHubLink(null as unknown as string)).toThrow(TypeError);
  });
});
