/**
 * @fileoverview A repository's documentation as account sources, read through a GitHub App's installation: each
 * repository read by its id at its default branch or at a named branch or commit, its tree read once a commit within a
 * request budget, the documentation kept by a filter, each file read as raw bytes under a cap, a push compared by the
 * tree at its `after` commit, and a link's ref settled where a branch name holds a slash. A selection, an item or a
 * call it cannot answer whole is refused before any request.
 * @module agentos-ext-github/documents/GitHubDocumentsConnector
 */

import {
  ReadCapExceeded,
  type AccountSourceConnector,
  type SourceChanges,
  type SourceGone,
  type SourceItem,
  type SourceRead,
  type SourceRef,
  type SourceSelection,
} from '@framers/agentos-ext-account-sources';
import type { GitHubAppCredential } from '../app/credential.js';
import { arrayOf, GITHUB_API_BASE, GitHubApiError, githubFetch, GitHubNoAnswer, githubSend, objectOf, repositoryPath, stringIn, type GitHubAnswer } from '../app/http.js';
import { DEFAULT_MAX_FILE_BYTES, extensionOf, pathFilter, readTree, SKIPPED_FOLDERS, type TreeBlob, type TreeFilter } from './tree.js';

/** One repository of a link. */
export interface LinkedRepository {
  /** The repository's id: every read addresses the repository by it. */
  id: number;
  /** `owner/name`, which names the repository in a read's attribution link alone. */
  fullName: string;
  defaultBranch: string;
}

/** What `list` reads: the repositories (`ids`), and the branch or commit a listing is made at. */
export interface GitHubListSelection extends SourceSelection {
  /**
   * A branch name, or a commit as 40 hexadecimal characters in either case, the listing is made at: the branch's head,
   * or the commit itself. The default branch's head when absent. Given, the selection names one repository.
   */
  at?: string;
}

/**
 * What `changesSince` compares: one repository (`ids` holds its id alone), the branch or commit the comparison follows
 * (`at`), and from a push its `after` commit and its `ref`, with the listing at `after` when the caller holds it.
 */
export interface GitHubChangesSelection extends GitHubListSelection {
  /** The commit to compare at; the head of the branch `at` names when absent, or `at` itself when it is a commit. */
  after?: string;
  /** The push's ref, such as `refs/heads/main`; a push to another branch than the one followed changes nothing. */
  ref?: string;
  /** The documentation's listing at `after`, which spares the tree's read; taken only with the `after` it was read at. */
  listing?: readonly TreeBlob[];
  /**
   * A branch name, or a commit as 40 hexadecimal characters, the listing and the comparison are made at; the default
   * branch's head when absent. A push's `ref` is read against `refs/heads/<at>` when `at` is a branch; a commit never
   * changes, so a push answers no change and an `after` naming another commit is refused.
   */
  at?: string;
}

/** The ref and the path a link's `<ref>/<path>` text names, as `resolveRef` settles them. */
export interface ResolvedRef {
  /** The branch's name, or the commit in lower case. */
  ref: string;
  /** The path under the ref, with no leading or trailing slash; `''` for the ref's root. */
  path: string;
  /** True when `ref` is a commit, which never moves. */
  commit: boolean;
}

/** A commit as a link or a caller names it: 40 hexadecimal characters, in either case. */
const COMMIT = /^[0-9a-f]{40}$/i;

/** The characters no branch name holds, beside the control characters and the space (`git check-ref-format`). */
const NOT_IN_BRANCH = '~^:?*[\\';

/**
 * True for a name git takes as a branch's (https://git-scm.com/docs/git-check-ref-format, with `--branch`): no part
 * empty, starting with a dot or ending in `.lock`; no `..`, `@{`, control character, space, `~`, `^`, `:`, `?`, `*`,
 * `[` or `\`; not ending with a dot, and neither `@` nor `HEAD`, nor starting with a dash.
 */
function isBranchName(name: string): boolean {
  if (name === '' || name === '@' || name === 'HEAD' || name.startsWith('-') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || NOT_IN_BRANCH.includes(name[index])) return false;
  }
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** What a listing or a comparison follows: a branch by its name, or a commit. */
type Followed = { branch: string } | { commit: string };

/**
 * The branch or the commit a caller's `at` names, a commit in lower case. Anything else throws a `TypeError` that
 * quotes none of it, before any request.
 */
function followedOf(at: unknown): Followed {
  if (typeof at === 'string' && COMMIT.test(at)) return { commit: at.toLowerCase() };
  if (typeof at === 'string' && isBranchName(at)) return { branch: at };
  throw new TypeError('at is a branch name or a commit of 40 hexadecimal characters');
}

/** The files answered as bytes with their media type; every other kept file is answered as text. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html',
  '.htm': 'text/html',
};

/** A path with each of its segments encoded for an address. */
function encodedPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * The blobs a cursor holds by path. A cursor this connector did not answer (not the JSON of an object of path to
 * blob) throws a `TypeError` that quotes none of it, since a cursor's text is a repository's paths.
 */
function blobsOf(cursor: string | null): Map<string, string> {
  if (cursor === null) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    // The parser's message would quote the cursor.
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.values(parsed).some((blob) => typeof blob !== 'string')) {
    throw new TypeError('the cursor is not one this connector answered');
  }
  return new Map(Object.entries(parsed as Record<string, string>));
}

/**
 * A repository id as a selection or an item id carries it: a positive integer in decimal with no sign, space or
 * leading zero, so each repository has one spelling. Anything else throws a `TypeError` that quotes none of it.
 */
function repositoryIdOf(text: string): number {
  const id = /^[1-9]\d*$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(id)) throw new TypeError('a repository id is a positive integer in decimal');
  return id;
}

/**
 * The repository and the path an item id names: `<repositoryId>:<path>`, split at its first colon. An id without a
 * path, or whose path has an empty, `.` or `..` segment, throws a `TypeError` that quotes none of it: its contents
 * address would name the repository's root listing or, once the dot segment is resolved, another endpoint.
 */
function itemPathOf(id: string): { repositoryId: number; path: string } {
  const colon = id.indexOf(':');
  if (colon < 0) throw new TypeError('an item id is <repositoryId>:<path>');
  const path = id.slice(colon + 1);
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError('an item id names no file: its path is empty or has an empty, . or .. segment');
  }
  return { repositoryId: repositoryIdOf(id.slice(0, colon)), path };
}

/**
 * Throws `GitHubNoAnswer` (`cancelled`) for a call whose signal is already aborted. Each call runs it first, before it
 * checks its inputs or makes any request, so an aborted call answers alike whatever its inputs, as the DOM standard
 * asks of an API that takes a signal ("Reject immediately if the AbortSignal is already aborted").
 */
function notCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new GitHubNoAnswer('cancelled');
}

/**
 * A repository's documentation as account sources: an item's id is `<repositoryId>:<path>`, its version
 * `<blob>@<commit>`, and the cursor of `changesSince` the JSON of each documentation path's blob at the commit last
 * read. A repository id is a positive integer in decimal. A call whose signal is already aborted throws
 * `GitHubNoAnswer` (`cancelled`) before it checks anything else. What a call cannot answer whole then throws before any
 * request: a `TypeError` for an id that is not a repository id, a repository named twice, an item id that names no
 * file, a change set of other than one repository, an `at` that is neither a branch name nor a commit or that names
 * other than one repository, and a link's text with an empty, `.` or `..` segment, and an `Error` for a repository
 * outside the link. An installation is removed by the app's own call (`uninstallInstallation`), never by a link's
 * connector.
 *
 * A listing and a comparison follow the default branch, or the branch or commit a selection's `at` names: a branch's
 * head is read when the call is made, a commit is read as it is and never changes.
 *
 * Every read addresses a linked repository by its id (`/repositories/<id>/...`, where GitHub's own redirects for a
 * renamed or moved repository lead), never by its name. A name can come to mean another repository (a renamed
 * repository's old name taken again, or an account's old login claimed by another account, which ends GitHub's
 * redirects), and GitHub answers a public repository's branch, tree and files to any token, the installation token
 * narrowed to the linked repository included, so a read by name could take in another account's repository. The full
 * name builds the attribution link alone.
 */
export class GitHubDocumentsConnector implements AccountSourceConnector {
  readonly kind = 'github';

  /**
   * @param credential The app's credential; each repository is read with an installation token narrowed to it.
   * @param installationId The installation the repositories are read through.
   * @param repositories The repositories of the link.
   * @param filter What is kept as documentation, and the bounds on reading it.
   * @param fetchImpl The fetch the repositories are read with.
   * @param apiBase GitHub's REST API, or a stand-in's address in tests.
   */
  constructor(
    private readonly credential: GitHubAppCredential,
    private readonly installationId: number,
    private readonly repositories: readonly LinkedRepository[],
    private readonly filter: TreeFilter = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = GITHUB_API_BASE,
  ) {}

  /** The linked repository of an id; one outside the link throws. */
  private repository(id: number): LinkedRepository {
    const found = this.repositories.find((repository) => repository.id === id);
    if (found === undefined) throw new Error(`repository ${id} is not part of this link`);
    return found;
  }

  /** An installation token narrowed to one repository, its request ended by the caller's signal. */
  private token(id: number, signal: AbortSignal | undefined): Promise<string> {
    return this.credential.installationToken(this.installationId, [id], { signal });
  }

  /** A linked repository's address under the API, by its id. */
  private address(repository: LinkedRepository): string {
    return `${this.apiBase}/${repositoryPath(repository.id)}`;
  }

  /** The head commit of a branch of a linked repository, its name encoded as one segment of the address. */
  private async branchHead(repository: LinkedRepository, branch: string, signal: AbortSignal | undefined): Promise<string> {
    const url = `${this.address(repository)}/branches/${encodeURIComponent(branch)}`;
    const answer = objectOf(await githubFetch(this.fetchImpl, url, { token: await this.token(repository.id, signal), signal }), 'a branch');
    return stringIn(objectOf(answer.commit, "a branch's commit"), 'sha', "a branch's commit");
  }

  /** The head commit of a repository's default branch. */
  head(repositoryId: number, signal?: AbortSignal): Promise<string>;
  /**
   * The head commit of the branch `at` names, the default branch's when `at` is undefined; for a commit of 40
   * hexadecimal characters, the commit itself in lower case, with no request. An `at` that is neither throws a
   * `TypeError` before any request; a branch the repository does not have throws GitHub's 404 as `GitHubApiError`.
   */
  head(repositoryId: number, at: string | undefined, signal?: AbortSignal): Promise<string>;
  async head(repositoryId: number, atOrSignal?: string | AbortSignal, laterSignal?: AbortSignal): Promise<string> {
    const at = typeof atOrSignal === 'string' ? atOrSignal : undefined;
    const signal = typeof atOrSignal === 'string' || atOrSignal === undefined ? laterSignal : atOrSignal;
    notCancelled(signal);
    const followed = at === undefined ? undefined : followedOf(at);
    const repository = this.repository(repositoryId);
    if (followed !== undefined && 'commit' in followed) return followed.commit;
    return this.branchHead(repository, followed?.branch ?? repository.defaultBranch, signal);
  }

  /**
   * The documentation files of a repository at a commit: its tree read once within the request budget, never walking
   * a skipped folder, then filtered. A caller keeps it for that commit and hands it to `changesSince` with that commit
   * as `after`.
   */
  async listing(repositoryId: number, commit: string, signal?: AbortSignal): Promise<TreeBlob[]> {
    notCancelled(signal);
    const repository = this.repository(repositoryId);
    const tree = await readTree(this.fetchImpl, await this.token(repositoryId, signal), repository.id, commit, this.apiBase, {
      maxRequests: this.filter.maxTreeRequests,
      skipFolders: this.filter.skipFolders ?? SKIPPED_FOLDERS,
      signal,
    });
    return pathFilter(this.filter)(tree);
  }

  /**
   * The documentation of each selected repository (its id in `ids`) at its default branch's head, or of one repository
   * at the branch or commit `at` names: the branch's head, or the commit itself with no branch read. Every id and `at`
   * are checked before any repository is read, so a selection is listed whole or not at all: an id that is not a
   * repository id, a repository named twice, an `at` that is neither a branch name nor a commit, and an `at` beside
   * other than one repository throw a `TypeError`, and a repository outside the link an `Error`. A selection's other
   * fields are `changesSince`'s, and a listing reads none of them.
   */
  async list(selection: GitHubListSelection, signal?: AbortSignal): Promise<{ items: SourceItem[]; gone: SourceGone[] }> {
    notCancelled(signal);
    const ids = selection.ids.map((id) => repositoryIdOf(id));
    if (new Set(ids).size < ids.length) throw new TypeError('a selection names a repository more than once');
    const followed = selection.at === undefined ? undefined : followedOf(selection.at);
    if (followed !== undefined && ids.length !== 1) throw new TypeError('a listing at a named branch or commit is of one repository');
    for (const id of ids) this.repository(id);
    const items: SourceItem[] = [];
    for (const id of ids) {
      const commit =
        followed === undefined ? await this.head(id, signal) : 'commit' in followed ? followed.commit : await this.head(id, followed.branch, signal);
      for (const blob of await this.listing(id, commit, signal)) {
        items.push({ id: `${id}:${blob.path}`, title: blob.path, size: blob.size, version: `${blob.sha}@${commit}` });
      }
    }
    return { items, gone: [] };
  }

  /**
   * A file's raw bytes at the commit of its version (the default branch when the version names no commit, and then
   * the reference names the branch), read as a stream under the call's deadline and cut at
   * `maxFileBytes`: PDF, Word and HTML as bytes with their media type, the rest as UTF-8 text, each with a `github`
   * attribution linking the file at that commit. A file GitHub no longer has (the contents read answers 404), or one
   * past the cap, is answered gone with reason `removed`; any other refusal throws `GitHubApiError`, a rate limit with
   * its `retryAt`, so a read GitHub held back is never taken for a file gone. So does a refusal of the installation
   * token (404 for an installation GitHub no longer has): a lost installation never reads as every file gone. An item
   * id that names no file (no path, or a path with an empty, `.` or `..` segment) throws a `TypeError` before any
   * request.
   */
  async read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone> {
    notCancelled(signal);
    const { repositoryId, path } = itemPathOf(item.id);
    const repository = this.repository(repositoryId);
    // A version that names no commit (none, no `@`, or nothing after it) reads the default branch.
    const commit = (item.version ?? '').split('@')[1] || repository.defaultBranch;
    const url = `${this.address(repository)}/contents/${encodedPath(path)}?ref=${encodeURIComponent(commit)}`;
    // Minted outside the try below: a 404 there is the file's, and the token's own refusal must reach the caller.
    const token = await this.token(repository.id, signal);
    let answer: GitHubAnswer;
    try {
      answer = await githubSend(this.fetchImpl, url, { token, accept: 'application/vnd.github.raw+json', signal });
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return { id: item.id, reason: 'removed' };
      throw error;
    }
    let bytes: Uint8Array;
    try {
      bytes = await answer.bytes(this.filter.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    } catch (error) {
      if (error instanceof ReadCapExceeded) return { id: item.id, reason: 'removed' };
      throw error;
    }
    const ref: SourceRef = {
      kind: 'github',
      title: path,
      path,
      // The ref's segments encoded as the path's are: Git allows a "#" in a branch name, which would end the address.
      url: `https://github.com/${repository.fullName}/blob/${encodedPath(commit)}/${encodedPath(path)}`,
      version: commit,
      readAt: new Date().toISOString(),
    };
    const mediaType = MEDIA_TYPES[extensionOf(path)];
    return { item, content: mediaType === undefined ? { text: new TextDecoder().decode(bytes) } : { bytes, mediaType }, ref };
  }

  /**
   * What a push to `after` changed in one repository, from the listing at `after` (read here when the caller holds
   * none) against the blobs read before (`cursor`: the JSON of each path's blob). A push's own commit lists are never
   * read, so a force push, or a push of more commits than its event lists, is read like any other. A cursor this
   * connector did not answer throws a `TypeError` before any request, whatever the push's branch, and so does a
   * selection of other than one repository, a `listing` without the `after` commit it was read at, or an `at` that is
   * neither a branch name nor a commit: call it once per repository, each with that repository's cursor.
   *
   * The comparison follows the default branch, or the branch or commit `at` names. Without `after` it is made at the
   * followed branch's head, or at the commit. A push to another branch than the one followed answers no change and the
   * cursor it was given, and so does any push when `at` is a commit, which never changes; without a push, an `after`
   * naming another commit than `at`'s throws a `TypeError` before any request.
   */
  async changesSince(cursor: string | null, selection: GitHubChangesSelection, signal?: AbortSignal): Promise<SourceChanges> {
    notCancelled(signal);
    const before = blobsOf(cursor);
    if (selection.ids.length !== 1) throw new TypeError('changesSince compares one repository a call');
    const id = repositoryIdOf(selection.ids[0]);
    if (selection.after === '') throw new TypeError('after names no commit');
    if (selection.listing !== undefined && selection.after === undefined) {
      throw new TypeError('a listing is compared only with the after commit it was read at');
    }
    const named = selection.at === undefined ? undefined : followedOf(selection.at);
    const repository = this.repository(id);
    const followed: Followed = named ?? { branch: repository.defaultBranch };
    if (selection.ref !== undefined && ('commit' in followed || selection.ref !== `refs/heads/${followed.branch}`)) {
      return { changed: [], gone: [], cursor: cursor ?? '{}' };
    }
    if ('commit' in followed && selection.after !== undefined && selection.after.toLowerCase() !== followed.commit) {
      throw new TypeError('after names another commit than at');
    }
    const after = 'commit' in followed ? followed.commit : (selection.after ?? (await this.branchHead(repository, followed.branch, signal)));
    const blobs = selection.listing ?? (await this.listing(id, after, signal));
    const now = new Map(blobs.map((blob) => [blob.path, blob.sha]));
    const changed = blobs
      .filter((blob) => before.get(blob.path) !== blob.sha)
      .map((blob) => ({ id: `${id}:${blob.path}`, title: blob.path, size: blob.size, version: `${blob.sha}@${after}` }));
    const gone = [...before.keys()].filter((path) => !now.has(path)).map((path) => ({ id: `${id}:${path}`, reason: 'removed' as const }));
    return { changed, gone, cursor: JSON.stringify(Object.fromEntries(now)) };
  }

  /**
   * The ref and the path of a folder's or a file's `<ref>/<path>` text (`parseGitHubLink`'s `refAndPath`), whose
   * branch name may hold a slash. A first segment of 40 hexadecimal characters is a commit, in lower case, and `HEAD`
   * the default branch (git names no branch `HEAD`), each settled with no request. Otherwise one request to GitHub's
   * matching references (`/repositories/<id>/git/matching-refs/heads/<first segment>`, under an installation token
   * narrowed to the repository), which answers every branch whose name starts with that segment
   * (https://docs.github.com/en/rest/git/refs#list-matching-references): the longest branch name that is the text, or
   * starts it at a slash, is the ref and the rest the path, and the first segment alone when none is longer. A first
   * segment no branch has is answered as the ref all the same, and a listing at it then answers GitHub's 404. A text
   * with an empty, `.` or `..` segment throws a `TypeError` that quotes none of it, before any request; GitHub's
   * refusal of the read, such as 409 for a repository with no commit, throws `GitHubApiError`.
   */
  async resolveRef(repositoryId: number, refAndPath: string, signal?: AbortSignal): Promise<ResolvedRef> {
    notCancelled(signal);
    if (typeof refAndPath !== 'string' || refAndPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new TypeError('a ref and a path have no empty, . or .. segment');
    }
    const repository = this.repository(repositoryId);
    const first = refAndPath.split('/')[0];
    const pathAfter = (ref: string): string => refAndPath.slice(ref.length + 1);
    if (COMMIT.test(first)) return { ref: first.toLowerCase(), path: pathAfter(first), commit: true };
    if (first === 'HEAD') return { ref: repository.defaultBranch, path: pathAfter(first), commit: false };
    const url = `${this.address(repository)}/git/matching-refs/heads/${encodeURIComponent(first)}`;
    const references = arrayOf(await githubFetch(this.fetchImpl, url, { token: await this.token(repository.id, signal), signal }), 'a list of references');
    let ref = first;
    for (const reference of references) {
      const name = stringIn(objectOf(reference, 'a reference'), 'ref', 'a reference');
      if (!name.startsWith('refs/heads/')) continue;
      const branch = name.slice('refs/heads/'.length);
      if (branch.length > ref.length && (refAndPath === branch || refAndPath.startsWith(`${branch}/`))) ref = branch;
    }
    return { ref, path: pathAfter(ref), commit: false };
  }

  /** Nothing to end here: an installation is removed by the app's own call (`uninstallInstallation`). */
  async revoke(): Promise<void> {
    // A link's connector holds no grant of its own; the app's installation outlives any one link.
  }
}
