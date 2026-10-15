/**
 * @fileoverview `GitHubDocumentsConnector` over a fetch stand-in that answers a repository's branch, trees and raw
 * files and records each request: the documentation filter, a truncated tree read by subtree within its request
 * budget, a listing kept for a commit, raw reads with their attribution and their cap, and a push compared by its tree.
 */

import { generateKeyPairSync } from 'node:crypto';
import type { SourceGone, SourceRead } from '@framers/agentos-ext-account-sources';
import { describe, expect, it } from 'vitest';
import { GitHubApiError, GitHubAppCredential, GitHubDocumentsConnector, TreeTooLarge, type LinkedRepository, type TreeFilter } from '../documents/index.js';

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
    if (path === '/repos/acme-team/handbook/branches/main') return json({ name: 'main', commit: { sha: C1 } });
    if (path === `/repos/acme-team/handbook/git/trees/${C1}` && recursive) return tree(C1, HANDBOOK_C1);
    if (path === `/repos/acme-team/handbook/git/trees/${C2}` && recursive) return tree(C2, HANDBOOK_C2);
    if (path === '/repos/acme-team/handbook/contents/docs/agenda.md' && url.searchParams.get('ref') === C1) return new Response(AGENDA);
    if (path === '/repos/acme-team/handbook/contents/docs/budget.pdf' && url.searchParams.get('ref') === C1) return new Response(PDF);
    if (path === '/repos/acme-team/handbook/contents/docs/long.md' && url.searchParams.get('ref') === C1) {
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
    if (path === '/repos/acme-team/handbook/contents/docs/limited.md') {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded for installation ID 5.' }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(LIMIT_RESET) },
      });
    }
    if (path === '/repos/acme-team/large/branches/main') return json({ name: 'main', commit: { sha: CL } });
    if (path === `/repos/acme-team/large/git/trees/${CL}` && recursive) {
      return tree(CL, [{ path: 'README.md', type: 'blob', sha: 'lr1', size: 90 }], true);
    }
    if (path === `/repos/acme-team/large/git/trees/${CL}`) {
      return tree(CL, [
        { path: 'README.md', type: 'blob', sha: 'lr1', size: 90 },
        { path: 'docs', type: 'tree', sha: 'ldocs' },
        { path: 'guide.md', type: 'blob', sha: 'lg1', size: 400 },
        { path: 'node_modules', type: 'tree', sha: 'lnm' },
        { path: 'src', type: 'tree', sha: 'lsrc' },
      ]);
    }
    if (path === '/repos/acme-team/large/git/trees/ldocs' && recursive) {
      return tree('ldocs', [
        { path: 'agenda.md', type: 'blob', sha: 'la1', size: 300 },
        { path: 'deep', type: 'tree', sha: 'ldeep' },
        { path: 'deep/notes.md', type: 'blob', sha: 'ln1', size: 200 },
      ]);
    }
    if (path === '/repos/acme-team/large/git/trees/lsrc' && recursive) return tree('lsrc', [{ path: 'index.ts', type: 'blob', sha: 'ls1', size: 50 }]);
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

/** The tree requests made, as their paths and queries after the repository. */
function treeRequests(seen: readonly Seen[]): string[] {
  return seen.filter((request) => request.url.includes('/git/trees/')).map((request) => request.url.slice(request.url.indexOf('/git/trees/') + '/git/trees/'.length));
}

/** The read, or a failure naming the reason it is gone. */
function asRead(answer: SourceRead | SourceGone): SourceRead {
  if ('reason' in answer) throw new Error(`answered gone: ${answer.reason}`);
  return answer;
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
    const branchRead = stand.seen.find((request) => request.url.endsWith('/repos/acme-team/handbook/branches/main'));
    expect(branchRead?.headers.get('authorization')).toBe('Bearer ghs_documents');
    expect(treeRequests(stand.seen)).toEqual([`${C1}?recursive=1`]);
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

    await expect(connectorOn(stand, { maxTreeRequests: 3 }).listing(78, CL)).rejects.toBeInstanceOf(TreeTooLarge);
    expect(treeRequests(stand.seen)).toEqual([`${CL}?recursive=1`, CL, 'ldocs?recursive=1']);
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
});
