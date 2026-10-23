/**
 * @fileoverview `GitHubDocumentsConnector` over a fetch stand-in that answers a repository's branch, trees and raw
 * files and records each request: the documentation filter, a truncated tree read by subtree within its request
 * budget, a folder GitHub cuts short refused whole, a listing kept for a commit, raw reads with their attribution and
 * their cap, a push compared by its tree, a repository read by its id whatever its name has come to mean, and the
 * selections, items and cancelled calls refused before any request.
 */

import { generateKeyPairSync } from 'node:crypto';
import { sourceRefLink, type SourceGone, type SourceRead } from '@framers/agentos-ext-account-sources';
import { describe, expect, it } from 'vitest';
import {
  CODE_EXTENSIONS,
  DEFAULT_MAX_FILE_BYTES,
  GitHubApiError,
  GitHubAppCredential,
  GitHubDocumentsConnector,
  GitHubNoAnswer,
  isGeneratedCode,
  pathFilter,
  readTree,
  TreeTooLarge,
  type GitHubChangesSelection,
  type LinkedRepository,
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

/** One entry of a tree answer. */
interface Entry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

/** A tree answer as GitHub gives it. */
function tree(sha: string, entries: readonly Entry[], truncated = false): Response {
  return json({ sha, truncated, tree: entries.map((entry) => ({ mode: entry.type === 'tree' ? '040000' : '100644', ...entry })) });
}

const BASE = 'https://stand-in.test';
const INSTALLATION = 5;
/** An installation the app no longer has: GitHub answers its token request 404. */
const GONE_INSTALLATION = 6;
const HANDBOOK: LinkedRepository = { id: 77, fullName: 'acme-team/handbook', defaultBranch: 'main' };
const LARGE: LinkedRepository = { id: 78, fullName: 'acme-team/large', defaultBranch: 'main' };
const C1 = '1'.repeat(40);
const C2 = '2'.repeat(40);
const C3 = '3'.repeat(40);
const CL = 'f'.repeat(40);
const AGENDA = '# Agenda\n\n1. The venue\n2. The budget\n';
const PDF = new TextEncoder().encode('%PDF-1.4\n% a test file\n');
const LONG_CHUNKS = 3;
const LONG_CHUNK_BYTES = 600_000;
/** When the stand-in's rate limit window resets, in UTC epoch seconds. */
const LIMIT_RESET = 2_000_000_000;

/** The handbook at C1: documentation, code, a file past the default cap, and built and vendored folders. */
const HANDBOOK_C1: readonly Entry[] = [
  { path: 'README.md', type: 'blob', sha: 'r1', size: 120 },
  { path: 'dist', type: 'tree', sha: 'td' },
  { path: 'dist/z.md', type: 'blob', sha: 'z1', size: 10 },
  { path: 'docs', type: 'tree', sha: 'tdocs' },
  { path: 'docs/agenda.md', type: 'blob', sha: 'a1', size: 300 },
  { path: 'docs/big.md', type: 'blob', sha: 'g1', size: 12 * 1024 * 1024 },
  { path: 'docs/budget.pdf', type: 'blob', sha: 'b1', size: 2048 },
  { path: 'node_modules/x/README.md', type: 'blob', sha: 'n1', size: 10 },
  { path: 'src/index.ts', type: 'blob', sha: 's1', size: 50 },
  { path: 'vendor/y.md', type: 'blob', sha: 'v1', size: 10 },
];

/** The handbook at C2: the agenda changed, an old page dropped by a force push. */
const HANDBOOK_C2: readonly Entry[] = [
  { path: 'README.md', type: 'blob', sha: 'r1', size: 120 },
  { path: 'docs/agenda.md', type: 'blob', sha: 'a2', size: 320 },
  { path: 'docs/budget.pdf', type: 'blob', sha: 'b1', size: 2048 },
];

/** A stand-in GitHub holding the two repositories; `pulled` counts the bytes a capped read drew from its stream. */
function github(): { fetchImpl: typeof fetch; seen: Seen[]; long: { pulled: number; cancelled: boolean } } {
  const seen: Seen[] = [];
  const long = { pulled: 0, cancelled: false };
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ method: init?.method ?? 'GET', url: href, headers: new Headers(init?.headers) });
    const url = new URL(href);
    const path = url.pathname;
    const recursive = url.searchParams.get('recursive') === '1';
    if (path === `/app/installations/${INSTALLATION}/access_tokens`) {
      return json({ token: 'ghs_documents', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (path === `/app/installations/${GONE_INSTALLATION}/access_tokens`) return json({ message: 'Not Found' }, 404);
    if (path === '/repositories/77/branches/main') return json({ name: 'main', commit: { sha: C1 } });
    if (path === `/repositories/77/git/trees/${C1}` && recursive) return tree(C1, HANDBOOK_C1);
    if (path === `/repositories/77/git/trees/${C2}` && recursive) return tree(C2, HANDBOOK_C2);
    if (path === '/repositories/77/contents/docs/agenda.md' && [C1, 'main'].includes(url.searchParams.get('ref') ?? '')) return new Response(AGENDA);
    if (path === '/repositories/77/contents/docs/budget.pdf' && url.searchParams.get('ref') === C1) return new Response(PDF);
    if (path === '/repositories/77/contents/docs/long.md' && url.searchParams.get('ref') === C1) {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (sent === LONG_CHUNKS) {
              controller.close();
              return;
            }
            sent += 1;
            long.pulled += LONG_CHUNK_BYTES;
            controller.enqueue(new Uint8Array(LONG_CHUNK_BYTES).fill(0x61));
          },
          cancel() {
            long.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body);
    }
    if (path === '/repositories/77/contents/docs/limited.md') {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded for installation ID 5.' }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(LIMIT_RESET) },
      });
    }
    if (path === '/repositories/78/branches/main') return json({ name: 'main', commit: { sha: CL } });
    if (path === `/repositories/78/git/trees/${CL}` && recursive) {
      return tree(CL, [{ path: 'README.md', type: 'blob', sha: 'lr1', size: 90 }], true);
    }
    if (path === `/repositories/78/git/trees/${CL}`) {
      return tree(CL, [
        { path: 'README.md', type: 'blob', sha: 'lr1', size: 90 },
        { path: 'docs', type: 'tree', sha: 'ldocs' },
        { path: 'guide.md', type: 'blob', sha: 'lg1', size: 400 },
        { path: 'node_modules', type: 'tree', sha: 'lnm' },
        { path: 'src', type: 'tree', sha: 'lsrc' },
      ]);
    }
    if (path === '/repositories/78/git/trees/ldocs' && recursive) {
      return tree('ldocs', [
        { path: 'agenda.md', type: 'blob', sha: 'la1', size: 300 },
        { path: 'deep', type: 'tree', sha: 'ldeep' },
        { path: 'deep/notes.md', type: 'blob', sha: 'ln1', size: 200 },
      ]);
    }
    if (path === '/repositories/78/git/trees/lsrc' && recursive) return tree('lsrc', [{ path: 'index.ts', type: 'blob', sha: 'ls1', size: 50 }]);
    return json({ message: 'Not Found' }, 404);
  };
  return { fetchImpl, seen, long };
}

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

/** A connector to both repositories of one installation, on the stand-in. */
function connectorOn(stand: ReturnType<typeof github>, filter: TreeFilter = {}): GitHubDocumentsConnector {
  const credential = new GitHubAppCredential({ clientId: 'Iv23liTESTCLIENT', privateKey: keys.privateKey }, stand.fetchImpl, BASE);
  return new GitHubDocumentsConnector(credential, INSTALLATION, [HANDBOOK, LARGE], filter, stand.fetchImpl, BASE);
}

/**
 * The stand-in, except that GitHub's installation token address never answers: its request rejects with its signal's
 * reason when the signal aborts, as fetch does.
 */
function tokensNeverAnswer(stand: ReturnType<typeof github>): typeof fetch {
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.endsWith('/access_tokens')) return stand.fetchImpl(input, init);
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      if (signal === undefined) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
}

/** A raw read's body the fetch left open: the cancels it got, and when a read waits on it. */
interface HeldContents {
  cancels: number;
  /** Settles once a read waits on the body past its first chunk. */
  stalled: Promise<void>;
}

/**
 * The stand-in, except that a raw read of `docs/stalled.md` answers the start of the file and then stalls, leaving its
 * body open when the read's signal aborts, as a fetch that does not tie its answer's body to its signal would.
 */
function contentsStall(stand: ReturnType<typeof github>): { fetchImpl: typeof fetch; held: HeldContents } {
  let waiting = (): void => undefined;
  const held: HeldContents = {
    cancels: 0,
    stalled: new Promise<void>((resolve) => {
      waiting = () => resolve();
    }),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!href.includes('/contents/docs/stalled.md')) return stand.fetchImpl(input, init);
    let pulls = 0;
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) controller.enqueue(new TextEncoder().encode('# Stalled\n'));
            else waiting();
          },
          cancel() {
            held.cancels += 1;
          },
        },
        { highWaterMark: 0 },
      ),
    );
  };
  return { fetchImpl, held };
}

/** The tree requests made, as their paths and queries after the repository. */
function treeRequests(seen: readonly Seen[]): string[] {
  return seen.filter((request) => request.url.includes('/git/trees/')).map((request) => request.url.slice(request.url.indexOf('/git/trees/') + '/git/trees/'.length));
}

/** The read, or a failure naming the reason it is gone. */
function asRead(answer: SourceRead | SourceGone): SourceRead {
  if ('reason' in answer) throw new Error(`answered gone: ${answer.reason}`);
  return answer;
}

/**
 * GitHub after the handbook's name has passed to another account's public repository, as it does once a renamed
 * repository's old name is taken again or the account's old login is claimed: the name answers that repository, whose
 * branch, tree and files any token can read, and the linked repository 77 answers by its id alone.
 */
function nameTakenOver(): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ method: init?.method ?? 'GET', url: href, headers: new Headers(init?.headers) });
    const url = new URL(href);
    const path = url.pathname;
    if (path === `/app/installations/${INSTALLATION}/access_tokens`) {
      return json({ token: 'ghs_documents', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (path === '/repositories/77/branches/main') return json({ name: 'main', commit: { sha: C1 } });
    if (path === `/repositories/77/git/trees/${C1}`) return tree(C1, HANDBOOK_C1);
    if (path === '/repositories/77/contents/docs/agenda.md' && url.searchParams.get('ref') === C1) return new Response(AGENDA);
    if (path === '/repos/acme-team/handbook/branches/main') return json({ name: 'main', commit: { sha: C3 } });
    if (path === `/repos/acme-team/handbook/git/trees/${C3}`) {
      return tree(C3, [
        { path: 'README.md', type: 'blob', sha: 'x1', size: 40 },
        { path: 'docs/agenda.md', type: 'blob', sha: 'x2', size: 40 },
      ]);
    }
    if (path.startsWith('/repos/acme-team/handbook/contents/')) return new Response('# Not the handbook\n');
    return json({ message: 'Not Found' }, 404);
  };
  return { fetchImpl, seen };
}

/** A repository with a folder too large for one tree answer, whatever way it is asked for. */
const HUGE: LinkedRepository = { id: 79, fullName: 'acme-team/huge', defaultBranch: 'main' };
const CH = 'e'.repeat(40);

/**
 * GitHub holding the huge repository: its tree at CH is cut short asked for recursively and asked for alone, as the
 * tree answer's required `truncated` field may say of any answer. The cut answer holds the files before the cut alone.
 */
function levelCut(): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ method: init?.method ?? 'GET', url: href, headers: new Headers(init?.headers) });
    const url = new URL(href);
    const path = url.pathname;
    const recursive = url.searchParams.get('recursive') === '1';
    if (path === `/app/installations/${INSTALLATION}/access_tokens`) {
      return json({ token: 'ghs_documents', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201);
    }
    if (path === '/repositories/79/branches/main') return json({ name: 'main', commit: { sha: CH } });
    if (path === `/repositories/79/git/trees/${CH}` && recursive) return tree(CH, [{ path: 'README.md', type: 'blob', sha: 'h1', size: 90 }], true);
    if (path === `/repositories/79/git/trees/${CH}`) {
      return tree(
        CH,
        [
          { path: 'README.md', type: 'blob', sha: 'h1', size: 90 },
          { path: 'docs', type: 'tree', sha: 'hdocs' },
        ],
        true,
      );
    }
    if (path === '/repositories/79/git/trees/hdocs' && recursive) return tree('hdocs', [{ path: 'guide.md', type: 'blob', sha: 'h2', size: 300 }]);
    return json({ message: 'Not Found' }, 404);
  };
  return { fetchImpl, seen };
}

describe('GitHubDocumentsConnector', () => {
  it("lists a repository's documentation at its default branch's head with the default filter", async () => {
    const stand = github();
    const listed = await connectorOn(stand).list({ ids: ['77'] });

    expect(listed).toEqual({
      items: [
        { id: '77:README.md', title: 'README.md', size: 120, version: `r1@${C1}` },
        { id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version: `a1@${C1}` },
        { id: '77:docs/budget.pdf', title: 'docs/budget.pdf', size: 2048, version: `b1@${C1}` },
      ],
      gone: [],
    });
    const branchRead = stand.seen.find((request) => request.url.endsWith('/repositories/77/branches/main'));
    expect(branchRead?.headers.get('authorization')).toBe('Bearer ghs_documents');
    expect(treeRequests(stand.seen)).toEqual([`${C1}?recursive=1`]);
  });

  it('keeps code beside the documentation only when asked, under the same bounds, leaving out code a tool wrote', async () => {
    const stand = github();
    const listed = await connectorOn(stand, { includeCode: true }).list({ ids: ['77'] });

    // src/index.ts joins the documentation; a skipped folder and the size cap still hold.
    expect(listed.items.map((item) => item.id)).toEqual(['77:README.md', '77:docs/agenda.md', '77:docs/budget.pdf', '77:src/index.ts']);
    expect(listed.items.find((item) => item.id === '77:src/index.ts')).toEqual({ id: '77:src/index.ts', title: 'src/index.ts', size: 50, version: `s1@${C1}` });

    const blob = (path: string, size = 10): { path: string; sha: string; size: number } => ({ path, sha: path, size });
    const blobs = [
      blob('app/main.py'),
      blob('app/Main.GO'),
      blob('web/site.min.js'),
      blob('web/vendor.bundle.js'),
      blob('api/service.pb.go'),
      blob('api/service_pb2.py'),
      blob('web/app.js'),
      blob('package-lock.json'),
      blob('config/settings.yaml'),
      blob('assets/logo.png'),
      blob('build/out.js'),
      blob('docs/guide.md'),
      blob('src/huge.ts', DEFAULT_MAX_FILE_BYTES + 1),
    ];
    expect(pathFilter({ includeCode: true })(blobs).map((kept) => kept.path)).toEqual(['app/Main.GO', 'app/main.py', 'docs/guide.md', 'web/app.js']);
    // Off by default: the documentation alone, as before.
    expect(pathFilter()(blobs).map((kept) => kept.path)).toEqual(['docs/guide.md']);
    expect(pathFilter({ includeCode: false })(blobs).map((kept) => kept.path)).toEqual(['docs/guide.md']);
    expect(CODE_EXTENSIONS.every((extension) => extension === extension.toLowerCase() && extension.startsWith('.'))).toBe(true);
    expect(['x.min.js', 'A/B.MIN.CSS', 'gen_pb2_grpc.py'].map(isGeneratedCode)).toEqual([true, true, true]);
    expect(['x.js', 'min.js', 'docs/pb2.md'].map(isGeneratedCode)).toEqual([false, false, false]);
  });

  it('reads a linked repository by its id, never through a name another repository has taken since the link was made', async () => {
    const stand = nameTakenOver();
    const credential = new GitHubAppCredential({ clientId: 'Iv23liTESTCLIENT', privateKey: keys.privateKey }, stand.fetchImpl, BASE);
    const connector = new GitHubDocumentsConnector(credential, INSTALLATION, [HANDBOOK], {}, stand.fetchImpl, BASE);

    expect(await connector.list({ ids: ['77'] })).toEqual({
      items: [
        { id: '77:README.md', title: 'README.md', size: 120, version: `r1@${C1}` },
        { id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version: `a1@${C1}` },
        { id: '77:docs/budget.pdf', title: 'docs/budget.pdf', size: 2048, version: `b1@${C1}` },
      ],
      gone: [],
    });
    const agenda = asRead(await connector.read({ id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version: `a1@${C1}` }));
    expect(agenda.content).toEqual({ text: AGENDA });
    const reads = stand.seen.filter((request) => !request.url.endsWith('/access_tokens')).map((request) => new URL(request.url).pathname);
    expect(reads).toEqual(['/repositories/77/branches/main', `/repositories/77/git/trees/${C1}`, '/repositories/77/contents/docs/agenda.md']);
  });

  it('reads a tree by a repository id, refusing one that is not a positive integer before any request', async () => {
    const stand = github();

    expect(await readTree(stand.fetchImpl, 'ghs_documents', 77, C2, BASE)).toEqual([
      { path: 'README.md', sha: 'r1', size: 120 },
      { path: 'docs/agenda.md', sha: 'a2', size: 320 },
      { path: 'docs/budget.pdf', sha: 'b1', size: 2048 },
    ]);
    expect(stand.seen.map((request) => request.url)).toEqual([`${BASE}/repositories/77/git/trees/${C2}?recursive=1`]);
    for (const repository of [0, -77, 7.5, Number.NaN, 2 ** 53]) {
      await expect(readTree(stand.fetchImpl, 'ghs_documents', repository, C2, BASE)).rejects.toBeInstanceOf(TypeError);
    }
    expect(stand.seen).toHaveLength(1);
  });

  it('reads a truncated tree by subtree, never walking a skipped folder', async () => {
    const stand = github();
    const listing = await connectorOn(stand).listing(78, CL);

    expect(listing).toEqual([
      { path: 'README.md', sha: 'lr1', size: 90 },
      { path: 'docs/agenda.md', sha: 'la1', size: 300 },
      { path: 'docs/deep/notes.md', sha: 'ln1', size: 200 },
      { path: 'guide.md', sha: 'lg1', size: 400 },
    ]);
    expect(treeRequests(stand.seen)).toEqual([`${CL}?recursive=1`, CL, 'ldocs?recursive=1', 'lsrc?recursive=1']);
  });

  it('refuses a truncated tree whose walk would pass the request budget, having made no request past it', async () => {
    const stand = github();

    const failure: unknown = await connectorOn(stand, { maxTreeRequests: 3 })
      .listing(78, CL)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TreeTooLarge);
    expect(failure).toMatchObject({ reason: 'budget', maxRequests: 3 });
    expect(treeRequests(stand.seen)).toEqual([`${CL}?recursive=1`, CL, 'ldocs?recursive=1']);
  });

  it('refuses a tree with a folder GitHub cuts short even asked for alone, so no file past the cut is answered removed', async () => {
    const stand = levelCut();
    const credential = new GitHubAppCredential({ clientId: 'Iv23liTESTCLIENT', privateKey: keys.privateKey }, stand.fetchImpl, BASE);
    const connector = new GitHubDocumentsConnector(credential, INSTALLATION, [HUGE], {}, stand.fetchImpl, BASE);

    const failure: unknown = await readTree(stand.fetchImpl, 'ghs_documents', 79, CH, BASE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TreeTooLarge);
    expect((failure as TreeTooLarge).reason).toBe('truncated');
    expect((failure as Error).message).not.toContain('requests');
    // The cut answer is refused where it comes, before any of its folders is asked for.
    expect(treeRequests(stand.seen)).toEqual([`${CH}?recursive=1`, CH]);

    // A cursor holding a file past the cut: a partial listing would answer it removed.
    const cursor = JSON.stringify({ 'README.md': 'h1', 'docs/guide.md': 'h2', 'zz/late.md': 'h9' });
    await expect(connector.changesSince(cursor, { ids: ['79'], after: CH })).rejects.toBeInstanceOf(TreeTooLarge);
    await expect(connector.list({ ids: ['79'] })).rejects.toBeInstanceOf(TreeTooLarge);
  });

  it('answers the listing at a commit, and compares a push against a listing it is given without any request', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const listing = await connector.listing(77, C1);
    expect(listing).toEqual([
      { path: 'README.md', sha: 'r1', size: 120 },
      { path: 'docs/agenda.md', sha: 'a1', size: 300 },
      { path: 'docs/budget.pdf', sha: 'b1', size: 2048 },
    ]);
    const before = stand.seen.length;

    const changes = await connector.changesSince(JSON.stringify({ 'README.md': 'r1', 'docs/agenda.md': 'a0' }), { ids: ['77'], after: C1, listing });
    expect(changes.changed).toEqual([
      { id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version: `a1@${C1}` },
      { id: '77:docs/budget.pdf', title: 'docs/budget.pdf', size: 2048, version: `b1@${C1}` },
    ]);
    expect(changes.gone).toEqual([]);
    expect(stand.seen.length).toBe(before);
  });

  it('reads Markdown as text and a PDF as bytes from their raw contents, each with its attribution at the commit', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    const agenda = asRead(await connector.read({ id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version: `a1@${C1}` }));
    expect(agenda.content).toEqual({ text: AGENDA });
    expect(agenda.ref).toMatchObject({
      kind: 'github',
      title: 'docs/agenda.md',
      path: 'docs/agenda.md',
      version: C1,
      url: `https://github.com/acme-team/handbook/blob/${C1}/docs/agenda.md`,
    });
    expect(Number.isNaN(Date.parse(agenda.ref.readAt))).toBe(false);

    const budget = asRead(await connector.read({ id: '77:docs/budget.pdf', title: 'docs/budget.pdf', size: 2048, version: `b1@${C1}` }));
    if (!('bytes' in budget.content)) throw new Error('the PDF was answered as text');
    expect(budget.content.mediaType).toBe('application/pdf');
    expect(Buffer.from(budget.content.bytes).equals(Buffer.from(PDF))).toBe(true);
    expect(budget.ref.url).toBe(`https://github.com/acme-team/handbook/blob/${C1}/docs/budget.pdf`);

    const reads = stand.seen.filter((request) => request.url.includes('/contents/'));
    expect(reads.map((request) => request.headers.get('accept'))).toEqual(['application/vnd.github.raw+json', 'application/vnd.github.raw+json']);
    expect(reads.every((request) => request.headers.get('authorization') === 'Bearer ghs_documents')).toBe(true);
    expect(reads.every((request) => request.headers.get('x-github-api-version') === '2026-03-10')).toBe(true);
  });

  it('answers a file whose raw read passes the cap as gone, without buffering it whole', async () => {
    const stand = github();
    const answer = await connectorOn(stand, { maxFileBytes: 1_000_000 }).read({ id: '77:docs/long.md', title: 'docs/long.md', size: null, version: `l1@${C1}` });

    expect(answer).toEqual({ id: '77:docs/long.md', reason: 'removed' });
    expect(stand.long.pulled).toBeLessThan(LONG_CHUNKS * LONG_CHUNK_BYTES);
    expect(stand.long.cancelled).toBe(true);
  });

  it("compares a push to the default branch by the tree at its after commit, never by the push's commit list", async () => {
    const stand = github();
    const previous = JSON.stringify({ 'README.md': 'r1', 'docs/agenda.md': 'a1', 'docs/budget.pdf': 'b1', 'docs/old.md': 'o1' });

    const changes = await connectorOn(stand).changesSince(previous, { ids: ['77'], after: C2, ref: 'refs/heads/main' });
    expect(changes.changed).toEqual([{ id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 320, version: `a2@${C2}` }]);
    expect(changes.gone).toEqual([{ id: '77:docs/old.md', reason: 'removed' }]);
    expect(JSON.parse(changes.cursor)).toEqual({ 'README.md': 'r1', 'docs/agenda.md': 'a2', 'docs/budget.pdf': 'b1' });
    expect(treeRequests(stand.seen)).toEqual([`${C2}?recursive=1`]);
    expect(stand.seen.some((request) => request.url.includes('/commits') || request.url.includes('/compare'))).toBe(false);
  });

  it('throws a read GitHub refuses for a rate limit with the time to try again, never answering the file gone', async () => {
    const stand = github();
    const failure: unknown = await connectorOn(stand)
      .read({ id: '77:docs/limited.md', title: 'docs/limited.md', size: 10, version: `m1@${C1}` })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubApiError);
    expect(failure).toMatchObject({ status: 403, rateLimited: true, retryAt: LIMIT_RESET * 1000 });
    expect((failure as Error).message).toBe('GitHub answered 403');
  });

  it('refuses a cursor it did not answer before any request, quoting none of it', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    for (const cursor of ['{"docs/private-plan.md":', '["docs/private-plan.md"]', '{"docs/private-plan.md":7}', 'null', '"docs/private-plan.md"']) {
      const failure: unknown = await connector.changesSince(cursor, { ids: ['77'], after: C1, listing: [] }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).not.toContain('private');
    }
    expect(stand.seen).toEqual([]);
  });

  it('answers a push to another branch with no change and no request', async () => {
    const stand = github();
    const previous = JSON.stringify({ 'README.md': 'r1' });

    const changes = await connectorOn(stand).changesSince(previous, { ids: ['77'], after: C3, ref: 'refs/heads/feature' });
    expect(changes).toEqual({ changed: [], gone: [], cursor: previous });
    expect(stand.seen).toEqual([]);
  });

  it('refuses a cursor it did not answer for a push to another branch too, so none is handed back to be kept', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    for (const cursor of ['{"docs/private-plan.md":', '["docs/private-plan.md"]', '{"docs/private-plan.md":7}', 'null']) {
      const failure: unknown = await connector.changesSince(cursor, { ids: ['77'], after: C3, ref: 'refs/heads/feature' }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).not.toContain('private');
    }
    expect(stand.seen).toEqual([]);
  });

  it('throws a read whose installation token GitHub refuses, so a lost installation never reads as every file gone', async () => {
    const stand = github();
    const credential = new GitHubAppCredential({ clientId: 'Iv23liTESTCLIENT', privateKey: keys.privateKey }, stand.fetchImpl, BASE);
    const connector = new GitHubDocumentsConnector(credential, GONE_INSTALLATION, [HANDBOOK], {}, stand.fetchImpl, BASE);

    const failure: unknown = await connector
      .read({ id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version: `a1@${C1}` })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubApiError);
    expect(failure).toMatchObject({ status: 404, rateLimited: false });
    expect(stand.seen.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([`POST /app/installations/${GONE_INSTALLATION}/access_tokens`]);
  });

  it("ends the installation token request at the caller's cancel", async () => {
    const stand = github();
    const fetchImpl = tokensNeverAnswer(stand);
    const credential = new GitHubAppCredential({ clientId: 'Iv23liTESTCLIENT', privateKey: keys.privateKey }, fetchImpl, BASE);
    const connector = new GitHubDocumentsConnector(credential, INSTALLATION, [HANDBOOK], {}, fetchImpl, BASE);
    const controller = new AbortController();

    const pending = connector.read({ id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version: `a1@${C1}` }, controller.signal).catch((error: unknown) => error);
    controller.abort();
    const failure = await pending;

    expect(failure).toBeInstanceOf(GitHubNoAnswer);
    expect((failure as GitHubNoAnswer).reason).toBe('cancelled');
    expect(stand.seen.some((request) => request.url.includes('/contents/'))).toBe(false);
  });

  it("cancels a raw read's body at the caller's cancel, so nothing more of the file is read", async () => {
    const stand = github();
    const { fetchImpl, held } = contentsStall(stand);
    const credential = new GitHubAppCredential({ clientId: 'Iv23liTESTCLIENT', privateKey: keys.privateKey }, fetchImpl, BASE);
    const connector = new GitHubDocumentsConnector(credential, INSTALLATION, [HANDBOOK], {}, fetchImpl, BASE);
    const controller = new AbortController();

    const pending = connector.read({ id: '77:docs/stalled.md', title: 'docs/stalled.md', size: 300, version: `t1@${C1}` }, controller.signal).catch((error: unknown) => error);
    await held.stalled;
    controller.abort();
    const failure = await pending;

    expect(failure).toBeInstanceOf(GitHubNoAnswer);
    expect((failure as GitHubNoAnswer).reason).toBe('cancelled');
    expect(held.cancels).toBe(1);
  });

  it('refuses, before any request, a change set it cannot answer whole: no repository or several, an id that is not a repository id, an after that names no commit, a listing without its commit', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const previous = JSON.stringify({ 'README.md': 'r1' });
    const listing = [{ path: 'README.md', sha: 'r1', size: 120 }];
    const selections: GitHubChangesSelection[] = [
      { ids: [] },
      { ids: ['77', '78'], after: C1 },
      { ids: ['077'], after: C1, listing },
      { ids: ['77 '], after: C1, listing },
      { ids: ['0x4d'], after: C1, listing },
      { ids: ['77'], after: '' },
      { ids: ['77'], after: '', listing },
      { ids: ['77'], listing },
    ];

    for (const selection of selections) {
      const failure: unknown = await connector.changesSince(previous, selection).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
    }
    expect(stand.seen).toEqual([]);
  });

  it('checks every selected id before reading any, so a selection is listed whole or not at all', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    expect(await connector.list({ ids: [] })).toEqual({ items: [], gone: [] });
    for (const ids of [['77', '79'], ['77', '077'], ['77', ''], ['77', '77']]) {
      await expect(connector.list({ ids })).rejects.toThrow();
    }
    expect(stand.seen).toEqual([]);
  });

  it('reads only the file an item names, refusing before any request an id without a path or a path with an empty, . or .. segment', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    for (const id of ['77', '77:', ':README.md', '077:README.md', '77:/README.md', '77:docs//agenda.md', '77:./README.md', '77:docs/../README.md', '77:docs/..']) {
      const failure: unknown = await connector.read({ id, title: 'README.md', size: 120, version: `r1@${C1}` }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
    }
    expect(stand.seen).toEqual([]);
  });

  it('reads an item whose version names no commit at the default branch, as it reads one without a version', async () => {
    const stand = github();
    const connector = connectorOn(stand);

    for (const version of [null, 'a1', 'a1@']) {
      const agenda = asRead(await connector.read({ id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version }));
      expect(agenda.content).toEqual({ text: AGENDA });
      expect(agenda.ref).toMatchObject({ version: 'main', url: 'https://github.com/acme-team/handbook/blob/main/docs/agenda.md' });
    }
    const refs = stand.seen.filter((request) => request.url.includes('/contents/')).map((request) => new URL(request.url).searchParams.get('ref'));
    expect(refs).toEqual(['main', 'main', 'main']);
  });

  it("links a file read at a default branch whose name holds a '#' by that name encoded, so the link and its line anchor reach the file", async () => {
    const stand = github();
    // Git allows a "#" in a branch name; GitHub decodes an encoded ref in a file's address.
    const hashed: LinkedRepository = { ...HANDBOOK, defaultBranch: 'docs#1' };
    const fetchImpl: typeof fetch = async (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(href);
      if (url.pathname === '/repositories/77/contents/docs/agenda.md' && url.searchParams.get('ref') === 'docs#1') return new Response(AGENDA);
      return stand.fetchImpl(input, init);
    };
    const credential = new GitHubAppCredential({ clientId: 'Iv23liTESTCLIENT', privateKey: keys.privateKey }, fetchImpl, BASE);
    const connector = new GitHubDocumentsConnector(credential, INSTALLATION, [hashed], {}, fetchImpl, BASE);

    const agenda = asRead(await connector.read({ id: '77:docs/agenda.md', title: 'docs/agenda.md', size: 300, version: null }));
    expect(agenda.content).toEqual({ text: AGENDA });
    expect(agenda.ref).toMatchObject({ version: 'docs#1', url: 'https://github.com/acme-team/handbook/blob/docs%231/docs/agenda.md' });
    expect(sourceRefLink({ ...agenda.ref, lines: [3, 4] })).toBe('https://github.com/acme-team/handbook/blob/docs%231/docs/agenda.md#L3-L4');
  });

  it('answers nothing to a call whose signal is already aborted, making no request', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const listing = [{ path: 'README.md', sha: 'r1', size: 120 }];
    const aborted = AbortSignal.abort();
    const calls: Array<() => Promise<unknown>> = [
      () => connector.list({ ids: ['77'] }, aborted),
      () => connector.read({ id: '77:README.md', title: 'README.md', size: 120, version: `r1@${C1}` }, aborted),
      () => connector.changesSince(JSON.stringify({ 'README.md': 'r0' }), { ids: ['77'], after: C1, listing }, aborted),
    ];

    for (const call of calls) {
      const failure: unknown = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GitHubNoAnswer);
      expect((failure as GitHubNoAnswer).reason).toBe('cancelled');
    }
    expect(stand.seen).toEqual([]);
  });

  it('answers an aborted call cancelled before it checks its inputs, so every aborted call answers alike', async () => {
    const stand = github();
    const connector = connectorOn(stand);
    const listing = [{ path: 'README.md', sha: 'r1', size: 120 }];
    const aborted = AbortSignal.abort();
    const calls: Array<() => Promise<unknown>> = [
      () => connector.list({ ids: ['077'] }, aborted),
      () => connector.list({ ids: ['77', '77'] }, aborted),
      () => connector.list({ ids: ['79'] }, aborted),
      () => connector.read({ id: '77', title: 'README.md', size: 120, version: `r1@${C1}` }, aborted),
      () => connector.read({ id: '79:README.md', title: 'README.md', size: 120, version: `r1@${C1}` }, aborted),
      () => connector.changesSince('not a cursor', { ids: ['77'], after: C1 }, aborted),
      () => connector.changesSince(null, { ids: [] }, aborted),
      () => connector.changesSince(null, { ids: ['77'], listing }, aborted),
      () => connector.changesSince(null, { ids: ['79'], after: C1 }, aborted),
      () => connector.head(79, aborted),
      () => connector.listing(79, C1, aborted),
    ];

    for (const call of calls) {
      const failure: unknown = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GitHubNoAnswer);
      expect((failure as GitHubNoAnswer).reason).toBe('cancelled');
    }
    expect(stand.seen).toEqual([]);
  });
});
