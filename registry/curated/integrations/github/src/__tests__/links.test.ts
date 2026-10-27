/**
 * @fileoverview `parseGitHubLink` over the addresses a person pastes: a repository, a folder and a file on github.com and
 * a file on raw.githubusercontent.com, each with and without `.git`, a trailing slash, a fragment and a query, under
 * http, with a port, without a scheme, and as the URL standard reads a special scheme without its two slashes, with
 * backslashes or with controls around it; a branch's and a tag's full names (`refs/heads/`, `refs/tags/`) kept whole,
 * as GitHub's own Raw links write them; the GitHub addresses the pack does not read, GitHub Enterprise Cloud's ghe.com
 * hosts among them, each refused and never answered as another site's; and the addresses of other hosts, which are not
 * GitHub's.
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
      // An address's host may end in more than one dot (https://url.spec.whatwg.org/#host-parsing keeps them all).
      'https://github.com../acme-team/handbook',
      'github.com...:8443/acme-team/handbook',
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
      // A branch's and a tag's full names kept whole, so resolveRef reads each among the branches or the tags alone.
      ['https://github.com/acme-team/handbook/tree/refs/heads/release/1.0/docs', folder('refs/heads/release/1.0/docs')],
      ['https://github.com/acme-team/handbook/tree/refs/heads/main', folder('refs/heads/main')],
      ['https://github.com/acme-team/handbook/tree/refs/tags/v1.0/docs', folder('refs/tags/v1.0/docs')],
      ['https://github.com/acme-team/handbook/tree/refs/tags/v1.0', folder('refs/tags/v1.0')],
      ['https://github.com/acme-team/handbook/tree/refs/tags/stable/2026.10/docs', folder('refs/tags/stable/2026.10/docs')],
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
      ['https://github.com/acme-team/handbook/raw/main/docs/agenda.md', file('main/docs/agenda.md', true)],
      ['https://raw.githubusercontent.com/acme-team/handbook/main/docs/agenda.md', file('main/docs/agenda.md', true)],
      // GitHub's own Raw links name the ref by its full name, refs/heads/<branch> or refs/tags/<tag>, kept whole: the
      // Raw link of a file at the tag v2.0.0 is https://github.com/cli/cli/raw/refs/tags/v2.0.0/README.md, which
      // redirects to raw.githubusercontent.com/cli/cli/refs/tags/v2.0.0/README.md.
      ['https://github.com/acme-team/handbook/blob/refs/heads/main/docs/agenda.md', file('refs/heads/main/docs/agenda.md')],
      ['https://github.com/acme-team/handbook/raw/refs/heads/main/docs/agenda.md', file('refs/heads/main/docs/agenda.md', true)],
      ['https://raw.githubusercontent.com/acme-team/handbook/refs/heads/main/docs/agenda.md', file('refs/heads/main/docs/agenda.md', true)],
      ['https://github.com/acme-team/handbook/raw/refs/heads/release/2.0/README.md', file('refs/heads/release/2.0/README.md', true)],
      ['https://github.com/acme-team/handbook/blob/refs/tags/v2.0.0/README.md', file('refs/tags/v2.0.0/README.md')],
      ['https://github.com/acme-team/handbook/raw/refs/tags/v2.0.0/README.md', file('refs/tags/v2.0.0/README.md', true)],
      ['https://raw.githubusercontent.com/acme-team/handbook/refs/tags/v2.0.0/README.md', file('refs/tags/v2.0.0/README.md', true)],
      ['raw.githubusercontent.com/acme-team/handbook/refs/tags/release/2.0/docs/notes.md', file('refs/tags/release/2.0/docs/notes.md', true)],
      ['http://raw.githubusercontent.com:8443/acme-team/handbook/main/README.md', file('main/README.md', true)],
      ['raw.githubusercontent.com/acme-team/handbook/main/README.md', file('main/README.md', true)],
      // The text may be a branch alone (release/1.0): resolveRef settles it, answering an empty path for a ref alone.
      ['https://github.com/acme-team/handbook/blob/release/1.0', file('release/1.0')],
    ];
    for (const [form, link] of forms) expect(parseGitHubLink(form), form).toEqual(link);
  });

  it('reads an address as the URL standard does: a special scheme without its two slashes or with backslashes, the controls and spaces around it, and tabs and newlines in it', () => {
    // After http, https, ws, wss and ftp the standard takes any run of / and \, none included, before the host
    // (https://url.spec.whatwg.org/#special-authority-slashes-state), and after file two of them; it drops the C0
    // controls and spaces around an address and every tab and newline in it
    // (https://url.spec.whatwg.org/#concept-basic-url-parser). A browser reads each of these as the GitHub address.
    const repositories = [
      'https:github.com/acme-team/handbook',
      'https:/github.com/acme-team/handbook',
      'http:github.com/acme-team/handbook',
      'HTTPS:///github.com/acme-team/handbook',
      'https:\\\\github.com\\acme-team\\handbook',
      'https:\\/github.com/acme-team/handbook',
      'https://github.com\\acme-team\\handbook',
      'wss:github.com/acme-team/handbook',
      'ftp:/github.com:8443/acme-team/handbook',
      'file:\\\\github.com\\acme-team\\handbook',
      '\u0001https://github.com/acme-team/handbook',
      'https://github.com/acme-team/handbook\u0000',
      '\u001f\u0000 https:github.com/acme-team/handbook \u0007',
      'ht\ttps://github.com/acme-team/handbook',
      'ht\ntps:git\r\nhub.com/acme-team/hand\tbook',
    ];
    for (const form of repositories) expect(parseGitHubLink(form), JSON.stringify(form)).toEqual(REPOSITORY);
    const forms: Array<[string, GitHubLink]> = [
      ['https:github.com/acme-team/handbook/tree/main/docs', folder('main/docs')],
      ['https:\\\\github.com\\acme-team\\handbook\\blob\\main\\docs\\agenda.md', file('main/docs/agenda.md')],
      ['\u0002http:/raw.githubusercontent.com/acme-team/handbook/main/README.md', file('main/README.md', true)],
    ];
    for (const [form, link] of forms) expect(parseGitHubLink(form), JSON.stringify(form)).toEqual(link);
    const credentials = [
      'https:someone:secret@github.com/acme-team/handbook',
      'http:ghp_secret@github.com/acme-team/handbook',
      'https:\\\\x-access-token:ghs_secret@github.com\\acme-team\\handbook',
    ];
    for (const form of credentials) expect(parseGitHubLink(form), form).toEqual(REFUSED);
    // A scheme the standard does not treat as special names a host only after "//"; another host is not GitHub's.
    for (const form of ['git:github.com/acme-team/handbook', 'https:example.com/acme-team/handbook', '\u0001mailto:someone@github.com']) {
      expect(parseGitHubLink(form), JSON.stringify(form)).toBeNull();
    }
    // After file and its two slashes, a third slash or backslash leaves the host empty
    // (https://url.spec.whatwg.org/#file-host-state): the address is a path on no host, and GitHub's name its first segment.
    for (const form of ['file:///github.com/acme-team/handbook', 'file:\\\\\\github.com\\acme-team\\handbook', 'FILE:\\//github.com/acme-team/handbook']) {
      expect(parseGitHubLink(form), JSON.stringify(form)).toBeNull();
    }
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
      // A full name with no path under /blob/ or /raw/ names no file (GitHub answers each 404), a namespace with no name
      // names no ref, and a reference that is neither a branch nor a tag is not read.
      'https://github.com/acme-team/handbook/blob/refs/heads/main',
      'https://github.com/acme-team/handbook/blob/refs/tags/v1.0',
      'https://github.com/acme-team/handbook/raw/refs/tags/v1.0',
      'https://raw.githubusercontent.com/acme-team/handbook/refs/tags/v1.0',
      'https://raw.githubusercontent.com/acme-team/handbook/refs/heads/main',
      'https://github.com/acme-team/handbook/tree/refs/heads',
      'https://github.com/acme-team/handbook/tree/refs/tags',
      'https://github.com/acme-team/handbook/tree/refs/pull/3/head',
      'https://github.com/acme-team/handbook/tree/refs/remotes/origin/main',
      'https://github.com/acme-team/handbook/tree/refs/tags/v1.0/%2E%2E%2Fsecret',
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
      // Credentials before a GitHub host with no scheme, which a browser opens as an https address.
      'x-access-token:ghs_secret@github.com/acme-team/handbook',
      'someone:secret@github.com/acme-team/handbook/tree/main/docs',
      'someone:secret@www.github.com:443/acme-team/handbook',
      'someone:secret@raw.githubusercontent.com/acme-team/handbook/main/README.md',
      // GitHub Enterprise Cloud with data residency: an enterprise on a subdomain of ghe.com, its API on
      // api.<subdomain>.ghe.com (https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency).
      'https://octocorp.ghe.com/acme-team/handbook',
      'https://octocorp.ghe.com/acme-team/handbook/tree/main/docs',
      'https://api.octocorp.ghe.com/repos/acme-team/handbook',
      'octocorp.ghe.com./acme-team/handbook',
      'https://ghe.com',
    ];
    for (const form of forms) expect(parseGitHubLink(form), form).toEqual(REFUSED);
  });

  it('answers a GitHub host as a GitHub form or refused, never as another site, whatever the scheme, its slashes, port, path, trailing dots or controls around it', () => {
    const hosts = [
      'github.com',
      'www.github.com',
      'gist.github.com',
      'api.github.com',
      'codeload.github.com',
      'raw.githubusercontent.com',
      'gist.githubusercontent.com',
      'ghe.com',
      'octocorp.ghe.com',
      'api.octocorp.ghe.com',
    ];
    const schemes = ['https://', 'http://', '', 'https:', 'http:/', 'https:\\\\', 'WSS:\\/', '\u0001https://', ' \u0000'];
    for (const host of hosts.flatMap((name) => [name, `${name}.`, `${name}..`])) {
      for (const scheme of schemes) {
        for (const port of ['', ':8080']) {
          for (const path of ['/', '/x', '/a/b/c/d/e/f', '/a/b/unknown/x', '/a/b?x=1#y']) {
            for (const tail of ['', '\u0000', ' \u001f']) {
              const form = `${scheme}${host}${port}${path}${tail}`;
              expect(parseGitHubLink(form), JSON.stringify(form)).not.toBeNull();
            }
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
      'https://ghe.com.example.org/acme-team/handbook',
      'https://notghe.com/acme-team/handbook',
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
