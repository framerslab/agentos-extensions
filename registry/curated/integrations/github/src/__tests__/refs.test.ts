/**
 * @fileoverview A link's ref settled through GitHub's matching references (a branch, then a tag, then a short commit
 * through GitHub's commits), a tree planned with what it leaves out and why, and a repository's documentation listed
 * and compared at a named branch or commit and within a folder, over a fetch stand-in that answers a repository's
 * branches, references, tags, commits and trees and records each request.
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FILE_BYTES,
  GitHubApiError,
  GitHubAppCredential,
  GitHubDocumentsConnector,
  GitHubNoAnswer,
  IMAGE_EXTENSIONS,
  pathFilter,
  planTree,
  type GitHubChangesSelection,
  type GitHubListSelection,
  type LinkedRepository,
  type PlannedBlob,
  type PlanTreeOptions,
  type TreeBlob,
  type TreeFilter,
} from '../documents/index.js';

/** One request the stand-in received. */
interface Seen {
  method: string;
  url: string;
  headers: Headers;
}

/** A JSON answer. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const BASE = 'https://stand-in.test';
const INSTALLATION = 5;
const HANDBOOK: LinkedRepository = { id: 77, fullName: 'acme-team/handbook', defaultBranch: 'main' };
/** A repository with no commit yet: GitHub answers its references 409. */
const EMPTY: LinkedRepository = { id: 80, fullName: 'acme-team/empty', defaultBranch: 'main' };
const MAIN = '1'.repeat(40);
const RELEASE = '2'.repeat(40);
const RELEASE_10 = '3'.repeat(40);
const RELEASE_NOTES = '4'.repeat(40);
const DOCS_1 = '5'.repeat(40);
/** The release branch's head after a push. */
const RELEASE_NEXT = '6'.repeat(40);
/** A commit a link pins. */
const PINNED = '9f2c4e6a'.repeat(5);
/** The commit a lightweight tag names. */
const TAGGED = '7'.repeat(40);
/** An annotated tag's own object, and the commit it names. */
const TAG_OBJECT = 'a'.repeat(40);
const ANNOTATED = '8'.repeat(40);
/** The commit a tag holding a slash names. */
const STABLE = 'b'.repeat(40);
/** A commit whose tree holds more documents before `docs/` than a listing keeps. */
const CROWDED = 'c'.repeat(40);

/** The handbook's branches by name. Git keeps no branch beside one under its name; the stand-in does, so the longest wins. */
const BRANCHES: Readonly<Record<string, string>> = {
  main: MAIN,
  release: RELEASE,
  'release/1.0': RELEASE_10,
  'release-notes': RELEASE_NOTES,
  'docs#1': DOCS_1,
};

/** The handbook's tags by name: a lightweight tag names a commit, an annotated tag its own tag object. */
const TAGS: Readonly<Record<string, { type: 'commit' | 'tag'; sha: string }>> = {
  'v1.0': { type: 'commit', sha: TAGGED },
  'v1.0-rc1': { type: 'commit', sha: MAIN },
  'v2.0': { type: 'tag', sha: TAG_OBJECT },
  'stable/2026.10': { type: 'commit', sha: STABLE },
  // A tag under a branch's name, which git keeps beside the branch: it names more of a link than the branch does.
  'release/2.0': { type: 'commit', sha: TAGGED },
  // A tag of a branch's name: the branch is read, and the tag never asked for.
  release: { type: 'commit', sha: PINNED },
};

/** Each annotated tag's object by its sha, with the commit it names. */
const TAG_OBJECTS: Readonly<Record<string, string>> = { [TAG_OBJECT]: ANNOTATED };

/** Every commit of the handbook, which a short commit names by its first characters. */
const COMMITS: readonly string[] = [MAIN, RELEASE, RELEASE_10, RELEASE_NOTES, DOCS_1, PINNED, TAGGED, ANNOTATED, STABLE, CROWDED];

/** One file of a tree answer. */
interface Entry {
  path: string;
  sha: string;
  size: number;
}

/** The handbook's trees by commit. */
const TREES: Readonly<Record<string, readonly Entry[]>> = {
  [MAIN]: [
    { path: 'README.md', sha: 'r1', size: 120 },
    { path: 'docs/agenda.md', sha: 'a1', size: 300 },
  ],
  [RELEASE]: [
    { path: 'README.md', sha: 'r1', size: 120 },
    { path: 'docs/agenda.md', sha: 'a2', size: 320 },
    { path: 'docs/setup.md', sha: 's1', size: 200 },
  ],
  [RELEASE_NEXT]: [
    { path: 'README.md', sha: 'r1', size: 120 },
    { path: 'docs/agenda.md', sha: 'a3', size: 330 },
  ],
  [RELEASE_10]: [{ path: 'docs/setup.md', sha: 's10', size: 210 }],
  [PINNED]: [
    { path: 'README.md', sha: 'r0', size: 100 },
    { path: 'docs/old.md', sha: 'o1', size: 50 },
  ],
  [TAGGED]: [{ path: 'docs/setup.md', sha: 's7', size: 70 }],
  [ANNOTATED]: [
    { path: 'README.md', sha: 'r8', size: 80 },
    { path: 'docs/setup.md', sha: 's8', size: 81 },
  ],
  [STABLE]: [{ path: 'docs/notes.md', sha: 'n9', size: 90 }],
  // Two thousand documents whose paths sort before docs/, as many as a listing keeps by default, then the folder's.
  [CROWDED]: [
    ...Array.from({ length: 2_000 }, (_, index): Entry => ({ path: `a/${String(index).padStart(4, '0')}.md`, sha: `x${index}`, size: 1 })),
    { path: 'docs/guide.md', sha: 'g1', size: 40 },
    { path: 'docs/setup.md', sha: 's2', size: 50 },
  ],
};

/** A stand-in GitHub holding the handbook and the empty repository. */
function github(): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ method: init?.method ?? 'GET', url: href, headers: new Headers(init?.headers) });
    const url = new URL(href);
    const path = url.pathname;
    if (path === `/app/installations/${INSTALLATION}/access_tokens`) {
      return json({ token: 'ghs_documents', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    const matching = '/repositories/77/git/matching-refs/heads/';
    if (path.startsWith(matching)) {
      // GitHub answers every reference whose name starts with the one asked for.
      const prefix = `refs/heads/${decodeURIComponent(path.slice(matching.length))}`;
      const references = Object.entries(BRANCHES).map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { type: 'commit', sha } }));
      return json(references.filter((reference) => reference.ref.startsWith(prefix)));
    }
    const matchingTags = '/repositories/77/git/matching-refs/tags/';
    if (path.startsWith(matchingTags)) {
      const prefix = `refs/tags/${decodeURIComponent(path.slice(matchingTags.length))}`;
      const references = Object.entries(TAGS).map(([name, object]) => ({ ref: `refs/tags/${name}`, object }));
      return json(references.filter((reference) => reference.ref.startsWith(prefix)));
    }
    const tagObjects = '/repositories/77/git/tags/';
    if (path.startsWith(tagObjects)) {
      const sha = path.slice(tagObjects.length);
      const commit = TAG_OBJECTS[sha];
      return commit === undefined ? json({ message: 'Not Found' }, 404) : json({ sha, tag: 'v2.0', object: { type: 'commit', sha: commit } });
    }
    const commits = '/repositories/77/commits/';
    if (path.startsWith(commits)) {
      // The commit's sha alone under GitHub's sha media type; 422 for a prefix no commit has, or several have.
      if (new Headers(init?.headers).get('accept') !== 'application/vnd.github.sha') return json({ message: 'Unsupported media type' }, 415);
      const prefix = decodeURIComponent(path.slice(commits.length)).toLowerCase();
      const found = COMMITS.filter((sha) => sha.startsWith(prefix));
      if (found.length !== 1) return json({ message: `No commit found for SHA: ${prefix}` }, 422);
      return new Response(found[0], { status: 200, headers: { 'content-type': 'application/vnd.github.sha; charset=utf-8' } });
    }
    if (path.startsWith('/repositories/80/git/matching-refs/')) return json({ message: 'Git Repository is empty.' }, 409);
    const branches = '/repositories/77/branches/';
    if (path.startsWith(branches)) {
      const name = decodeURIComponent(path.slice(branches.length));
      const sha = BRANCHES[name];
      return sha === undefined ? json({ message: 'Branch not found' }, 404) : json({ name, commit: { sha } });
    }
    const trees = '/repositories/77/git/trees/';
    const entries = path.startsWith(trees) && url.searchParams.get('recursive') === '1' ? TREES[path.slice(trees.length)] : undefined;
    if (entries !== undefined) {
      return json({ sha: path.slice(trees.length), truncated: false, tree: entries.map((entry) => ({ mode: '100644', type: 'blob', ...entry })) });
    }
    return json({ message: 'Not Found' }, 404);
  };
  return { fetchImpl, seen };
}

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

/** A connector to the handbook and the empty repository, on the stand-in. */
function connectorOn(stand: ReturnType<typeof github>, filter: TreeFilter = {}): GitHubDocumentsConnector {
  const credential = new GitHubAppCredential({ clientId: 'Iv23liTESTCLIENT', privateKey: keys.privateKey }, stand.fetchImpl, BASE);
  return new GitHubDocumentsConnector(credential, INSTALLATION, [HANDBOOK, EMPTY], filter, stand.fetchImpl, BASE);
}

/** The requests made other than for an installation token, as their paths and queries. */
function reads(seen: readonly Seen[]): string[] {
  return seen.filter((request) => !request.url.endsWith('/access_tokens')).map((request) => request.url.slice(BASE.length));
}

/** A plan as its paths and outcomes. */
function outcomes(plan: readonly PlannedBlob[]): Array<[string, PlannedBlob['outcome']]> {
  return plan.map((planned): [string, PlannedBlob['outcome']] => [planned.path, planned.outcome]);
}

/** A blob of ten bytes, or of `size`. */
function blob(path: string, size = 10): TreeBlob {
  return { path, sha: `b-${path}`, size };
}

describe('resolveRef', () => {
  it("settles a branch holding a slash through GitHub's matching references, by the repository's id, the tags read for a longer name", async () => {
    const stand = github();

    expect(await connectorOn(stand).resolveRef(77, 'release/1.0/docs/setup.md')).toEqual({
      ref: 'release/1.0',
      path: 'docs/setup.md',
      commit: false,
      kind: 'branch',
      name: 'release/1.0',
    });
    expect(reads(stand.seen)).toEqual(['/repositories/77/git/matching-refs/heads/release', '/repositories/77/git/matching-refs/tags/release']);
    const request = stand.seen.find((seen) => seen.url.includes('/matching-refs/'));
    expect(request?.headers.get('authorization')).toBe('Bearer ghs_documents');
    expect(request?.headers.get('x-github-api-version')).toBe('2026-03-10');
  });

  it('takes the longest branch that is the text or starts it at a slash, never one that only starts with the same letters', async () => {
    const connector = connectorOn(github());

    expect(await connector.resolveRef(77, 'main/docs')).toEqual({ ref: 'main', path: 'docs', commit: false, kind: 'branch', name: 'main' });
    expect(await connector.resolveRef(77, 'release/docs/setup.md')).toEqual({
      ref: 'release',
      path: 'docs/setup.md',
      commit: false,
      kind: 'branch',
      name: 'release',
    });
    expect(await connector.resolveRef(77, 'release/1.0')).toEqual({ ref: 'release/1.0', path: '', commit: false, kind: 'branch', name: 'release/1.0' });
    expect(await connector.resolveRef(77, 'release-notes/2026.md')).toEqual({
      ref: 'release-notes',
      path: '2026.md',
      commit: false,
      kind: 'branch',
      name: 'release-notes',
    });
    // No branch, tag or commit is the segment: the segment alone is the ref, and the listing at it answers GitHub's 404.
    expect(await connector.resolveRef(77, 'nightly/docs')).toEqual({ ref: 'nightly', path: 'docs', commit: false, kind: 'branch', name: 'nightly' });
  });

  it('asks for the first segment encoded, so a branch holding a # is asked for whole, and the tags the same way', async () => {
    const stand = github();

    expect(await connectorOn(stand).resolveRef(77, 'docs#1/guide.md')).toEqual({ ref: 'docs#1', path: 'guide.md', commit: false, kind: 'branch', name: 'docs#1' });
    expect(reads(stand.seen)).toEqual(['/repositories/77/git/matching-refs/heads/docs%231', '/repositories/77/git/matching-refs/tags/docs%231']);
  });

  it('takes a commit of 40 hexadecimal characters in either case, and HEAD as the default branch, with no request', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    expect(await connector.resolveRef(77, `${PINNED}/docs/old.md`)).toEqual({ ref: PINNED, path: 'docs/old.md', commit: true, kind: 'commit', name: PINNED });
    expect(await connector.resolveRef(77, `${PINNED.toUpperCase()}/docs`)).toEqual({
      ref: PINNED,
      path: 'docs',
      commit: true,
      kind: 'commit',
      name: PINNED.toUpperCase(),
    });
    expect(await connector.resolveRef(77, PINNED)).toEqual({ ref: PINNED, path: '', commit: true, kind: 'commit', name: PINNED });
    expect(await connector.resolveRef(77, 'HEAD/docs/agenda.md')).toEqual({ ref: 'main', path: 'docs/agenda.md', commit: false, kind: 'branch', name: 'HEAD' });
    expect(stand.seen).toEqual([]);
  });

  it('settles a tag no branch is at the commit it names: a lightweight tag at its own, an annotated tag peeled, the longest tag that is the text or starts it at a slash', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    expect(await connector.resolveRef(77, 'v1.0/docs')).toEqual({ ref: TAGGED, path: 'docs', commit: true, kind: 'tag', name: 'v1.0' });
    expect(reads(stand.seen)).toEqual(['/repositories/77/git/matching-refs/heads/v1.0', '/repositories/77/git/matching-refs/tags/v1.0']);
    expect(await connector.resolveRef(77, 'v2.0/docs/setup.md')).toEqual({ ref: ANNOTATED, path: 'docs/setup.md', commit: true, kind: 'tag', name: 'v2.0' });
    expect(reads(stand.seen).slice(2)).toEqual([
      '/repositories/77/git/matching-refs/heads/v2.0',
      '/repositories/77/git/matching-refs/tags/v2.0',
      `/repositories/77/git/tags/${TAG_OBJECT}`,
    ]);
    expect(await connector.resolveRef(77, 'stable/2026.10/docs')).toEqual({ ref: STABLE, path: 'docs', commit: true, kind: 'tag', name: 'stable/2026.10' });
    expect(await connector.resolveRef(77, 'v1.0')).toEqual({ ref: TAGGED, path: '', commit: true, kind: 'tag', name: 'v1.0' });
    // A branch and a tag of one name: the tags are read for a longer name, and the same name settles as the branch.
    const before = stand.seen.length;
    expect(await connector.resolveRef(77, 'release/docs')).toEqual({ ref: 'release', path: 'docs', commit: false, kind: 'branch', name: 'release' });
    expect(reads(stand.seen.slice(before))).toEqual(['/repositories/77/git/matching-refs/heads/release', '/repositories/77/git/matching-refs/tags/release']);
    // A branch whose name is the whole text: no name of a tag is longer, so no tag is asked for.
    const whole = stand.seen.length;
    expect(await connector.resolveRef(77, 'release/1.0')).toEqual({ ref: 'release/1.0', path: '', commit: false, kind: 'branch', name: 'release/1.0' });
    expect(reads(stand.seen.slice(whole))).toEqual(['/repositories/77/git/matching-refs/heads/release']);
  });

  it('takes a tag that names more of the text than the branch it starts with, the longest name of a branch or a tag', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    // The branch `release` starts `release/2.0/docs` at a slash, and the tag `release/2.0` names more of it.
    expect(await connector.resolveRef(77, 'release/2.0/docs')).toEqual({ ref: TAGGED, path: 'docs', commit: true, kind: 'tag', name: 'release/2.0' });
    expect(reads(stand.seen)).toEqual(['/repositories/77/git/matching-refs/heads/release', '/repositories/77/git/matching-refs/tags/release']);
  });

  it("settles a short commit through GitHub's commits, asked for its sha alone, and asks no commit for a name that cannot be one", async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const short = PINNED.slice(0, 7);

    expect(await connector.resolveRef(77, `${short}/docs/old.md`)).toEqual({ ref: PINNED, path: 'docs/old.md', commit: true, kind: 'commit', name: short });
    expect(reads(stand.seen)).toEqual([
      `/repositories/77/git/matching-refs/heads/${short}`,
      `/repositories/77/git/matching-refs/tags/${short}`,
      `/repositories/77/commits/${short}`,
    ]);
    expect(stand.seen[stand.seen.length - 1].headers.get('accept')).toBe('application/vnd.github.sha');
    expect(await connector.resolveRef(77, `${short.toUpperCase()}/docs`)).toEqual({
      ref: PINNED,
      path: 'docs',
      commit: true,
      kind: 'commit',
      name: short.toUpperCase(),
    });
    // GitHub answers 422 for a prefix no commit has: the segment is answered as a branch, whose listing answers 404.
    const nowhere = await connector.resolveRef(77, 'abcdef0/docs');
    expect(nowhere).toEqual({ ref: 'abcdef0', path: 'docs', commit: false, kind: 'branch', name: 'abcdef0' });
    const listed: unknown = await connector.list({ ids: ['77'], at: nowhere.ref }).catch((error: unknown) => error);
    expect(listed).toBeInstanceOf(GitHubApiError);
    expect((listed as GitHubApiError).status).toBe(404);
    // Fewer than four hexadecimal characters, or any other letter, names no commit: GitHub's commits are not asked.
    for (const text of ['abc/docs', 'nightly/docs']) {
      const before = stand.seen.length;
      const first = text.split('/')[0];
      expect(await connector.resolveRef(77, text), text).toEqual({ ref: first, path: 'docs', commit: false, kind: 'branch', name: first });
      expect(reads(stand.seen.slice(before)), text).toEqual([
        `/repositories/77/git/matching-refs/heads/${first}`,
        `/repositories/77/git/matching-refs/tags/${first}`,
      ]);
    }
  });

  it('lists, reads the head of and compares a tag and a short commit at the commit resolveRef answers, with no branch read', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const tag = await connector.resolveRef(77, 'v2.0/docs');
    const short = await connector.resolveRef(77, `${TAGGED.slice(0, 8)}/docs`);
    const before = stand.seen.length;

    expect(await connector.list({ ids: ['77'], at: tag.ref })).toEqual({
      items: [
        { id: '77:README.md', title: 'README.md', size: 80, version: `r8@${ANNOTATED}` },
        { id: '77:docs/setup.md', title: 'docs/setup.md', size: 81, version: `s8@${ANNOTATED}` },
      ],
      gone: [],
    });
    expect((await connector.list({ ids: ['77'], at: short.ref })).items).toEqual([
      { id: '77:docs/setup.md', title: 'docs/setup.md', size: 70, version: `s7@${TAGGED}` },
    ]);
    expect(await connector.head(77, tag.ref)).toBe(ANNOTATED);
    expect(await connector.head(77, short.ref)).toBe(TAGGED);
    // Read at a commit, a tag's listing never changes: a push to any branch answers no change.
    const cursor = JSON.stringify({ 'README.md': 'r8', 'docs/setup.md': 's8' });
    expect(await connector.changesSince(cursor, { ids: ['77'], at: tag.ref, ref: 'refs/heads/main', after: MAIN })).toEqual({ changed: [], gone: [], cursor });
    expect(await connector.changesSince(cursor, { ids: ['77'], at: tag.ref })).toEqual({ changed: [], gone: [], cursor });
    expect(reads(stand.seen.slice(before))).toEqual([
      `/repositories/77/git/trees/${ANNOTATED}?recursive=1`,
      `/repositories/77/git/trees/${TAGGED}?recursive=1`,
      `/repositories/77/git/trees/${ANNOTATED}?recursive=1`,
    ]);
  });

  it('refuses, before any request, a first segment no ref name can begin, and after the reads one no branch, tag or commit is that is no branch name', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const unnamed = ['a:b/docs', 'a~1/docs', 'a^/docs', 'a?/docs', 'a*/docs', 'a[1]/docs', 'a\\b/docs', 'a@{1}/docs', 'x..y/docs', '.hidden/docs', 'x.lock/docs', 'a b/docs', 'a\tb/docs'];

    for (const text of unnamed) {
      await expect(connector.resolveRef(77, text), text).rejects.toBeInstanceOf(TypeError);
    }
    expect(stand.seen).toEqual([]);
    // A segment that may begin a longer ref name but is no branch name alone, which no branch, tag or commit is.
    for (const text of ['-x/docs', '@/docs', 'end./docs']) {
      await expect(connector.resolveRef(77, text), text).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('refuses, before any request, a text with an empty, . or .. segment, a repository outside the link and an aborted call', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    for (const text of ['', '/main/docs', 'main/', 'main//docs', './docs', 'main/./docs', 'main/../secret', '..']) {
      const failure: unknown = await connector.resolveRef(77, text).catch((error: unknown) => error);
      expect(failure, text).toBeInstanceOf(TypeError);
      expect((failure as Error).message).not.toContain('secret');
    }
    await expect(connector.resolveRef(79, 'main/docs')).rejects.toThrow('repository 79 is not part of this link');
    const aborted: unknown = await connector.resolveRef(77, '', AbortSignal.abort()).catch((error: unknown) => error);
    expect(aborted).toBeInstanceOf(GitHubNoAnswer);
    expect((aborted as GitHubNoAnswer).reason).toBe('cancelled');
    expect(stand.seen).toEqual([]);
  });

  it("throws GitHub's refusal of the references, never a ref it did not read", async () => {
    const failure: unknown = await connectorOn(github())
      .resolveRef(80, 'main/docs')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubApiError);
    expect((failure as GitHubApiError).status).toBe(409);
  });
});

describe('planTree', () => {
  const TREE: readonly TreeBlob[] = [
    blob('src/index.ts', 50),
    blob('README.md', 120),
    blob('docs/big.md', 12 * 1024 * 1024),
    blob('assets/logo.png', 4096),
    blob('docs/budget.pdf', 2048),
    blob('node_modules/x/README.md'),
    blob('docs/agenda.md', 300),
  ];

  it('answers every file in path order: the documentation a note, the rest skipped with its reason', () => {
    expect(outcomes(planTree(TREE))).toEqual([
      ['README.md', 'note'],
      ['assets/logo.png', { skipped: 'image' }],
      ['docs/agenda.md', 'note'],
      ['docs/big.md', { skipped: 'size' }],
      ['docs/budget.pdf', 'note'],
      ['node_modules/x/README.md', { skipped: 'folder' }],
      ['src/index.ts', { skipped: 'code' }],
    ]);
    expect(planTree(TREE, { includeCode: true }).find((planned) => planned.path === 'src/index.ts')?.outcome).toBe('note');
  });

  it('tells code left out from code a tool wrote, a file of no kind it reads, and a code file past its own bound', () => {
    const blobs = [
      blob('package.json'),
      blob('config/settings.yaml'),
      blob('LICENSE'),
      blob('web/app.min.js'),
      blob('web/app.js'),
      blob('src/huge.ts', 2_000_000),
      blob('docs/long.md', 2_000_000),
    ];

    expect(outcomes(planTree(blobs))).toEqual([
      ['LICENSE', { skipped: 'kind' }],
      ['config/settings.yaml', { skipped: 'kind' }],
      ['docs/long.md', 'note'],
      ['package.json', { skipped: 'kind' }],
      ['src/huge.ts', { skipped: 'code' }],
      ['web/app.js', { skipped: 'code' }],
      ['web/app.min.js', { skipped: 'code' }],
    ]);
    expect(outcomes(planTree(blobs, { includeCode: true, maxCodeBytes: 1_048_576 }))).toEqual([
      ['LICENSE', { skipped: 'kind' }],
      ['config/settings.yaml', { skipped: 'kind' }],
      ['docs/long.md', 'note'],
      ['package.json', { skipped: 'kind' }],
      ['src/huge.ts', { skipped: 'size' }],
      ['web/app.js', 'note'],
      ['web/app.min.js', { skipped: 'generated' }],
    ]);
  });

  it('bounds a code file by maxCodeBytes while code is asked for, even when the filter names its extension as documentation', () => {
    const blobs = [blob('docs/guide.md', 2_000_000), blob('src/huge.ts', 2_000_000), blob('src/small.ts', 100)];
    const filter: PlanTreeOptions = { extensions: ['.md', '.ts'], maxCodeBytes: 1_048_576 };

    expect(outcomes(planTree(blobs, { ...filter, includeCode: true }))).toEqual([
      ['docs/guide.md', 'note'],
      ['src/huge.ts', { skipped: 'size' }],
      ['src/small.ts', 'note'],
    ]);
    // Without code asked for, an extension the filter names is documentation alone, under maxFileBytes.
    expect(outcomes(planTree(blobs, filter))).toEqual([
      ['docs/guide.md', 'note'],
      ['src/huge.ts', 'note'],
      ['src/small.ts', 'note'],
    ]);
  });

  it('keeps the documentation first under the file count and the code in the room left, the rest past the count', () => {
    const blobs = [blob('api/a.ts'), blob('api/b.ts'), blob('app/c.py'), blob('docs/guide.md'), blob('docs/z.md')];

    expect(outcomes(planTree(blobs, { includeCode: true, maxFiles: 3 }))).toEqual([
      ['api/a.ts', 'note'],
      ['api/b.ts', { skipped: 'count' }],
      ['app/c.py', { skipped: 'count' }],
      ['docs/guide.md', 'note'],
      ['docs/z.md', 'note'],
    ]);
    expect(outcomes(planTree(blobs, { maxFiles: 1 }))).toEqual([
      ['api/a.ts', { skipped: 'code' }],
      ['api/b.ts', { skipped: 'code' }],
      ['app/c.py', { skipped: 'code' }],
      ['docs/guide.md', 'note'],
      ['docs/z.md', { skipped: 'count' }],
    ]);
  });

  it('answers as notes exactly what pathFilter keeps under the same filter', () => {
    const blobs = [
      ...TREE,
      blob('web/app.min.js'),
      blob('web/app.js'),
      blob('docs/x.min.js'),
      blob('package.json'),
      blob('vendor/y.md'),
      blob('src/big.ts', DEFAULT_MAX_FILE_BYTES + 1),
      ...Array.from({ length: 6 }, (_, index) => blob(`notes/n${index}.md`)),
      ...Array.from({ length: 6 }, (_, index) => blob(`lib/m${index}.py`)),
    ];
    const filters: TreeFilter[] = [
      {},
      { includeCode: true },
      { maxFiles: 4 },
      { includeCode: true, maxFiles: 9 },
      { includeCode: true, maxFiles: 12 },
      { extensions: ['.md', '.js'] },
      { includeCode: true, extensions: ['.md', '.js'] },
      { skipFolders: [] },
      { maxFileBytes: 100 },
    ];

    for (const filter of filters) {
      const notes = planTree(blobs, filter)
        .filter((planned) => planned.outcome === 'note')
        .map(({ path, sha, size }) => ({ path, sha, size }));
      expect(notes, JSON.stringify(filter)).toEqual(pathFilter(filter)(blobs));
    }
  });

  it('reads the image extensions it is given, and keeps as documentation any extension the filter names', () => {
    const blobs = [blob('art/cover.png'), blob('art/scan.jxl')];

    expect(outcomes(planTree(blobs))).toEqual([
      ['art/cover.png', { skipped: 'image' }],
      ['art/scan.jxl', { skipped: 'kind' }],
    ]);
    expect(outcomes(planTree(blobs, { imageExtensions: ['.JXL'] }))).toEqual([
      ['art/cover.png', { skipped: 'kind' }],
      ['art/scan.jxl', { skipped: 'image' }],
    ]);
    expect(outcomes(planTree(blobs, { extensions: ['.png'] }))).toEqual([
      ['art/cover.png', 'note'],
      ['art/scan.jxl', { skipped: 'kind' }],
    ]);
    expect(IMAGE_EXTENSIONS).toContain('.svg');
  });

  it('answers new objects holding the path, the sha, the size and the outcome alone, and refuses a code bound that is not a size', () => {
    const held = { path: 'README.md', sha: 'r1', size: 120, mode: '100644' } as TreeBlob;

    expect(planTree([held])).toEqual([{ path: 'README.md', sha: 'r1', size: 120, outcome: 'note' }]);
    for (const maxCodeBytes of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => planTree([], { maxCodeBytes }), String(maxCodeBytes)).toThrow(TypeError);
    }
  });
});

describe('the listing at a named branch or commit', () => {
  it("lists the head of the branch at names, a slash in its name included, and a commit with no branch read", async () => {
    const stand = github();
    const connector = connectorOn(stand);

    expect(await connector.list({ ids: ['77'], at: 'release' })).toEqual({
      items: [
        { id: '77:README.md', title: 'README.md', size: 120, version: `r1@${RELEASE}` },
        { id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 320, version: `a2@${RELEASE}` },
        { id: '77:docs/setup.md', title: 'docs/setup.md', size: 200, version: `s1@${RELEASE}` },
      ],
      gone: [],
    });
    expect((await connector.list({ ids: ['77'], at: 'release/1.0' })).items).toEqual([
      { id: '77:docs/setup.md', title: 'docs/setup.md', size: 210, version: `s10@${RELEASE_10}` },
    ]);
    expect((await connector.list({ ids: ['77'], at: PINNED.toUpperCase() })).items).toEqual([
      { id: '77:README.md', title: 'README.md', size: 100, version: `r0@${PINNED}` },
      { id: '77:docs/old.md', title: 'docs/old.md', size: 50, version: `o1@${PINNED}` },
    ]);
    expect(reads(stand.seen)).toEqual([
      '/repositories/77/branches/release',
      `/repositories/77/git/trees/${RELEASE}?recursive=1`,
      '/repositories/77/branches/release%2F1.0',
      `/repositories/77/git/trees/${RELEASE_10}?recursive=1`,
      `/repositories/77/git/trees/${PINNED}?recursive=1`,
    ]);
  });

  it("compares at the head of the branch at names when no push names a commit", async () => {
    const stand = github();

    const changes = await connectorOn(stand).changesSince(JSON.stringify({ 'README.md': 'r1' }), { ids: ['77'], at: 'release' });
    expect(changes.changed.map((item) => item.version)).toEqual([`a2@${RELEASE}`, `s1@${RELEASE}`]);
    expect(changes.gone).toEqual([]);
    expect(reads(stand.seen)).toEqual(['/repositories/77/branches/release', `/repositories/77/git/trees/${RELEASE}?recursive=1`]);
  });

  it('compares a push to the branch at names, and answers a push to any other branch, the default included, with no change and no request', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const previous = JSON.stringify({ 'README.md': 'r1', 'docs/agenda.md': 'a2', 'docs/setup.md': 's1' });

    const changes = await connector.changesSince(previous, { ids: ['77'], at: 'release', ref: 'refs/heads/release', after: RELEASE_NEXT });
    expect(changes.changed).toEqual([{ id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 330, version: `a3@${RELEASE_NEXT}` }]);
    expect(changes.gone).toEqual([{ id: '77:docs/setup.md', reason: 'removed' }]);
    expect(reads(stand.seen)).toEqual([`/repositories/77/git/trees/${RELEASE_NEXT}?recursive=1`]);

    const before = stand.seen.length;
    expect(await connector.changesSince(previous, { ids: ['77'], at: 'release', ref: 'refs/heads/main', after: MAIN })).toEqual({ changed: [], gone: [], cursor: previous });
    expect(await connector.changesSince(previous, { ids: ['77'], at: 'release/1.0', ref: 'refs/heads/release', after: RELEASE_NEXT })).toEqual({
      changed: [],
      gone: [],
      cursor: previous,
    });
    expect(stand.seen.length).toBe(before);
  });

  it('compares a commit at itself, so a push never changes it, and refuses an after naming another commit', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const cursor = JSON.stringify({ 'README.md': 'r0', 'docs/old.md': 'o1' });

    expect(await connector.changesSince(cursor, { ids: ['77'], at: PINNED })).toEqual({ changed: [], gone: [], cursor });
    expect(await connector.changesSince(null, { ids: ['77'], at: PINNED.toUpperCase(), after: PINNED })).toEqual({
      changed: [
        { id: '77:README.md', title: 'README.md', size: 100, version: `r0@${PINNED}` },
        { id: '77:docs/old.md', title: 'docs/old.md', size: 50, version: `o1@${PINNED}` },
      ],
      gone: [],
      cursor,
    });
    expect(reads(stand.seen)).toEqual([`/repositories/77/git/trees/${PINNED}?recursive=1`, `/repositories/77/git/trees/${PINNED}?recursive=1`]);

    const before = stand.seen.length;
    expect(await connector.changesSince(cursor, { ids: ['77'], at: PINNED, ref: 'refs/heads/main', after: MAIN })).toEqual({ changed: [], gone: [], cursor });
    await expect(connector.changesSince(cursor, { ids: ['77'], at: PINNED, after: MAIN })).rejects.toBeInstanceOf(TypeError);
    expect(stand.seen.length).toBe(before);
  });

  it('reads head at a named branch or commit, and at the default branch when handed a signal alone as before', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    expect(await connector.head(77, 'release/1.0')).toBe(RELEASE_10);
    expect(await connector.head(77, PINNED.toUpperCase())).toBe(PINNED);
    expect(await connector.head(77)).toBe(MAIN);
    expect(await connector.head(77, new AbortController().signal)).toBe(MAIN);
    expect(await connector.head(77, undefined, new AbortController().signal)).toBe(MAIN);
    expect(reads(stand.seen)).toEqual([
      '/repositories/77/branches/release%2F1.0',
      '/repositories/77/branches/main',
      '/repositories/77/branches/main',
      '/repositories/77/branches/main',
    ]);
  });

  it('refuses, before any request, an at that is neither a branch name nor a commit, and an at over other than one repository', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const names = ['', 'feature..x', 'feature x', '-x', 'HEAD', '@', 'release/', '/release', 'release//1.0', 'x.lock', 'docs/.hidden', 'end.'];

    for (const at of [...names, 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[1]', 'a\\b', 'a@{1}', 'a\tb']) {
      await expect(connector.list({ ids: ['77'], at }), at).rejects.toBeInstanceOf(TypeError);
      await expect(connector.changesSince(null, { ids: ['77'], at }), at).rejects.toBeInstanceOf(TypeError);
      await expect(connector.head(77, at), at).rejects.toBeInstanceOf(TypeError);
    }
    await expect(connector.list({ ids: ['77', '80'], at: 'release' })).rejects.toBeInstanceOf(TypeError);
    await expect(connector.list({ ids: [], at: 'release' })).rejects.toBeInstanceOf(TypeError);
    expect(stand.seen).toEqual([]);
  });

  it('answers an aborted call cancelled before it checks at', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const aborted = AbortSignal.abort();
    const calls: Array<() => Promise<unknown>> = [
      () => connector.list({ ids: ['77'], at: '' }, aborted),
      () => connector.changesSince(null, { ids: ['77'], at: '' }, aborted),
      () => connector.head(77, '', aborted),
      () => connector.head(77, 'release', aborted),
    ];

    for (const call of calls) {
      const failure: unknown = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GitHubNoAnswer);
      expect((failure as GitHubNoAnswer).reason).toBe('cancelled');
    }
    expect(stand.seen).toEqual([]);
  });
});

describe('the listing of a folder or a file', () => {
  /** The folder `docs` of the crowded commit, whose two thousand documents under `a/` sort before it. */
  const folder = { ids: ['77'], at: CROWDED, path: 'docs' };
  const GUIDE = { id: '77:docs/guide.md', title: 'docs/guide.md', size: 40, version: `g1@${CROWDED}` };
  const SETUP = { id: '77:docs/setup.md', title: 'docs/setup.md', size: 50, version: `s2@${CROWDED}` };

  it("keeps the folder's files before the file count, so the files sorting before it never crowd them out", async () => {
    const connector = connectorOn(github());

    // Over the whole repository the count keeps a/ alone: a filter of that listing finds none of the folder's files.
    const whole = await connector.list({ ids: ['77'], at: CROWDED });
    expect(whole.items).toHaveLength(2_000);
    expect(whole.items.filter((item) => item.title.startsWith('docs/'))).toEqual([]);
    expect(await connector.list(folder)).toEqual({ items: [GUIDE, SETUP], gone: [] });
    const everything = { ids: ['77'], at: CROWDED, path: '' };
    expect((await connector.list(everything)).items).toHaveLength(2_000);
  });

  it('answers the file a path names, as a /tree/ address naming a file does, and nothing for a path the tree does not hold', async () => {
    const connector = connectorOn(github());
    const file = { ids: ['77'], at: CROWDED, path: 'docs/guide.md' };
    const missing = { ids: ['77'], at: CROWDED, path: 'docs/guide' };

    expect((await connector.list(file)).items).toEqual([GUIDE]);
    expect((await connector.list(missing)).items).toEqual([]);
  });

  it("compares the folder alone, so its files are never answered gone for the files sorting before it", async () => {
    const connector = connectorOn(github());
    const cursor = JSON.stringify({ 'docs/guide.md': 'g1', 'docs/setup.md': 's2' });

    expect(await connector.changesSince(cursor, folder)).toEqual({ changed: [], gone: [], cursor });
    // Over the whole repository the folder's files are past the count, and read as gone though GitHub has them.
    const whole = await connector.changesSince(cursor, { ids: ['77'], at: CROWDED });
    expect(whole.gone).toEqual([
      { id: '77:docs/guide.md', reason: 'removed' },
      { id: '77:docs/setup.md', reason: 'removed' },
    ]);
  });

  it('reads the folder afresh when a listing handed in holds the whole count, which may have been cut before the folder', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const cursor = JSON.stringify({ 'docs/guide.md': 'g1', 'docs/setup.md': 's2' });

    // A listing of the whole repository keeps a/ alone: narrowed to docs it would answer the folder's files gone.
    const whole = await connector.listing(77, CROWDED);
    expect(whole).toHaveLength(2_000);
    const compared = { ids: ['77'], at: CROWDED, after: CROWDED, listing: whole, path: 'docs' };
    expect(await connector.changesSince(cursor, compared)).toEqual({ changed: [], gone: [], cursor });
  });

  it("reads a folder's listing to hand changesSince, under the caller's signal", async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const listingOf = connector.listing.bind(connector) as unknown as (
      repositoryId: number,
      commit: string,
      options: { path?: string; signal?: AbortSignal },
    ) => Promise<TreeBlob[]>;

    const listing = await listingOf(77, CROWDED, { path: 'docs' });
    expect(listing).toEqual([
      { path: 'docs/guide.md', sha: 'g1', size: 40 },
      { path: 'docs/setup.md', sha: 's2', size: 50 },
    ]);
    const before = stand.seen.length;
    const compared = { ids: ['77'], at: CROWDED, after: CROWDED, listing, path: 'docs' };
    expect(await connector.changesSince(JSON.stringify({ 'docs/guide.md': 'g0' }), compared)).toEqual({
      changed: [GUIDE, SETUP],
      gone: [],
      cursor: JSON.stringify({ 'docs/guide.md': 'g1', 'docs/setup.md': 's2' }),
    });
    expect(stand.seen.length).toBe(before);
    const aborted: unknown = await listingOf(77, CROWDED, { path: 'docs', signal: AbortSignal.abort() }).catch((error: unknown) => error);
    expect(aborted).toBeInstanceOf(GitHubNoAnswer);
    expect((aborted as GitHubNoAnswer).reason).toBe('cancelled');
    expect(stand.seen.length).toBe(before);
  });

  it('plans the folder or the file alone, its files counted before the count bound, as list keeps them', () => {
    const crowded: TreeBlob[] = TREES[CROWDED].map((entry) => ({ ...entry }));

    expect(planTree(crowded).filter((planned) => planned.path.startsWith('docs/')).map((planned) => planned.outcome)).toEqual([
      { skipped: 'count' },
      { skipped: 'count' },
    ]);
    const inFolder = { path: 'docs', maxFiles: 2_000 };
    expect(outcomes(planTree(crowded, inFolder))).toEqual([
      ['docs/guide.md', 'note'],
      ['docs/setup.md', 'note'],
    ]);
    const oneFile = { path: 'docs/guide.md', maxFiles: 2_000 };
    expect(outcomes(planTree(crowded, oneFile))).toEqual([['docs/guide.md', 'note']]);
  });

  it('refuses, before any request, a path that is not text or has an empty, . or .. segment, and a folder of other than one repository', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    for (const path of ['docs/', '/docs', 'docs//guide.md', './docs', 'docs/..', 'docs/./guide.md', '..', 42, null]) {
      const selection = { ids: ['77'], at: CROWDED, path } as unknown as GitHubListSelection;
      await expect(connector.list(selection), String(path)).rejects.toBeInstanceOf(TypeError);
      await expect(connector.changesSince(null, selection as GitHubChangesSelection), String(path)).rejects.toBeInstanceOf(TypeError);
      expect(() => planTree([], { path, maxFiles: 1 } as unknown as PlanTreeOptions), String(path)).toThrow(TypeError);
    }
    const two = { ids: ['77', '80'], path: 'docs' };
    await expect(connector.list(two)).rejects.toBeInstanceOf(TypeError);
    expect(stand.seen).toEqual([]);
  });
});
