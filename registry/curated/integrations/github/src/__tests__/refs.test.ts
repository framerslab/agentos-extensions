/**
 * @fileoverview A link's ref settled through GitHub's matching references, a tree planned with what it leaves out and
 * why, and a repository's documentation listed and compared at a named branch or commit, over a fetch stand-in that
 * answers a repository's branches, references and trees and records each request.
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
  type LinkedRepository,
  type PlannedBlob,
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

/** The handbook's branches by name. Git keeps no branch beside one under its name; the stand-in does, so the longest wins. */
const BRANCHES: Readonly<Record<string, string>> = {
  main: MAIN,
  release: RELEASE,
  'release/1.0': RELEASE_10,
  'release-notes': RELEASE_NOTES,
  'docs#1': DOCS_1,
};

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
  it("settles a branch holding a slash with one request to GitHub's matching references, by the repository's id", async () => {
    const stand = github();

    expect(await connectorOn(stand).resolveRef(77, 'release/1.0/docs/setup.md')).toEqual({ ref: 'release/1.0', path: 'docs/setup.md', commit: false });
    expect(reads(stand.seen)).toEqual(['/repositories/77/git/matching-refs/heads/release']);
    const request = stand.seen.find((seen) => seen.url.includes('/matching-refs/'));
    expect(request?.headers.get('authorization')).toBe('Bearer ghs_documents');
    expect(request?.headers.get('x-github-api-version')).toBe('2026-03-10');
  });

  it('takes the longest branch that is the text or starts it at a slash, never one that only starts with the same letters', async () => {
    const connector = connectorOn(github());

    expect(await connector.resolveRef(77, 'main/docs')).toEqual({ ref: 'main', path: 'docs', commit: false });
    expect(await connector.resolveRef(77, 'release/docs/setup.md')).toEqual({ ref: 'release', path: 'docs/setup.md', commit: false });
    expect(await connector.resolveRef(77, 'release/1.0')).toEqual({ ref: 'release/1.0', path: '', commit: false });
    expect(await connector.resolveRef(77, 'release-notes/2026.md')).toEqual({ ref: 'release-notes', path: '2026.md', commit: false });
    // No branch starts with the segment: the segment alone is the ref, and the listing at it answers GitHub's 404.
    expect(await connector.resolveRef(77, 'nightly/docs')).toEqual({ ref: 'nightly', path: 'docs', commit: false });
  });

  it('asks for the first segment encoded, so a branch holding a # is asked for whole', async () => {
    const stand = github();

    expect(await connectorOn(stand).resolveRef(77, 'docs#1/guide.md')).toEqual({ ref: 'docs#1', path: 'guide.md', commit: false });
    expect(reads(stand.seen)).toEqual(['/repositories/77/git/matching-refs/heads/docs%231']);
  });

  it('takes a commit of 40 hexadecimal characters in either case, and HEAD as the default branch, with no request', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    expect(await connector.resolveRef(77, `${PINNED}/docs/old.md`)).toEqual({ ref: PINNED, path: 'docs/old.md', commit: true });
    expect(await connector.resolveRef(77, `${PINNED.toUpperCase()}/docs`)).toEqual({ ref: PINNED, path: 'docs', commit: true });
    expect(await connector.resolveRef(77, PINNED)).toEqual({ ref: PINNED, path: '', commit: true });
    expect(await connector.resolveRef(77, 'HEAD/docs/agenda.md')).toEqual({ ref: 'main', path: 'docs/agenda.md', commit: false });
    expect(stand.seen).toEqual([]);
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

  it('answers new objects holding the path, the blob, the size and the outcome alone, and refuses a code bound that is not a size', () => {
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
