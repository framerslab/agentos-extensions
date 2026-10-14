/**
 * @fileoverview A repository's documentation as account sources, read through a GitHub App's installation: each
 * repository's tree read once a commit within a request budget, the documentation kept by a filter, each file read as
 * raw bytes under a cap, and a push compared by the tree at its `after` commit.
 * @module agentos-ext-github/documents/GitHubDocumentsConnector
 */

import {
  readCapped,
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
import { discardBody, GITHUB_API_BASE, GitHubApiError, githubFetch, githubHeaders, objectOf, stringIn } from '../app/http.js';
import { DEFAULT_MAX_FILE_BYTES, extensionOf, pathFilter, readTree, SKIPPED_FOLDERS, type TreeBlob, type TreeFilter } from './tree.js';

/** One repository of a link. */
export interface LinkedRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
}

/**
 * What `changesSince` compares: the repository (its id, first of `ids`), and from a push its `after` commit and its
 * `ref`, with the listing at `after` when the caller holds it.
 */
export interface GitHubChangesSelection extends SourceSelection {
  /** The commit to compare at; the default branch's head when absent. */
  after?: string;
  /** The push's ref, such as `refs/heads/main`; a push to another branch than the default changes nothing. */
  ref?: string;
  /** The documentation's listing at `after`, which spares the tree's read. */
  listing?: readonly TreeBlob[];
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
 * A repository's documentation as account sources: an item's id is `<repositoryId>:<path>`, its version
 * `<blob>@<commit>`, and the cursor of `changesSince` the JSON of each documentation path's blob at the commit last
 * read. An installation is removed by the app's own call (`uninstallInstallation`), never by a link's connector.
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

  private repository(id: number): LinkedRepository {
    const found = this.repositories.find((repository) => repository.id === id);
    if (found === undefined) throw new Error(`repository ${id} is not part of this link`);
    return found;
  }

  private token(id: number): Promise<string> {
    return this.credential.installationToken(this.installationId, [id]);
  }

  /** The head commit of a repository's default branch. */
  async head(repositoryId: number, signal?: AbortSignal): Promise<string> {
    const repository = this.repository(repositoryId);
    const url = `${this.apiBase}/repos/${repository.fullName}/branches/${encodeURIComponent(repository.defaultBranch)}`;
    const branch = objectOf(await githubFetch(this.fetchImpl, url, { token: await this.token(repositoryId), signal }), 'a branch');
    return stringIn(objectOf(branch.commit, "a branch's commit"), 'sha', "a branch's commit");
  }

  /**
   * The documentation files of a repository at a commit: its tree read once within the request budget, never walking
   * a skipped folder, then filtered. A caller keeps it for that commit and hands it to `changesSince`.
   */
  async listing(repositoryId: number, commit: string, signal?: AbortSignal): Promise<TreeBlob[]> {
    const tree = await readTree(this.fetchImpl, await this.token(repositoryId), this.repository(repositoryId).fullName, commit, this.apiBase, {
      maxRequests: this.filter.maxTreeRequests,
      skipFolders: this.filter.skipFolders ?? SKIPPED_FOLDERS,
      signal,
    });
    return pathFilter(this.filter)(tree);
  }

  /** The documentation of each selected repository (its id in `ids`) at its default branch's head. */
  async list(selection: SourceSelection, signal?: AbortSignal): Promise<{ items: SourceItem[]; gone: SourceGone[] }> {
    const items: SourceItem[] = [];
    for (const id of selection.ids.map(Number)) {
      const commit = await this.head(id, signal);
      for (const blob of await this.listing(id, commit, signal)) {
        items.push({ id: `${id}:${blob.path}`, title: blob.path, size: blob.size, version: `${blob.sha}@${commit}` });
      }
    }
    return { items, gone: [] };
  }

  /**
   * A file's raw bytes at the commit of its version, read as a stream and cut at `maxFileBytes`: PDF, Word and HTML
   * as bytes with their media type, the rest as UTF-8 text, each with a `github` attribution linking the file at that
   * commit. A file GitHub no longer has, or one past the cap, is answered gone with reason `removed`.
   */
  async read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone> {
    const [repositoryId, ...rest] = item.id.split(':');
    const path = rest.join(':');
    const repository = this.repository(Number(repositoryId));
    const commit = (item.version ?? '').split('@')[1] ?? repository.defaultBranch;
    const response = await this.fetchImpl(`${this.apiBase}/repos/${repository.fullName}/contents/${encodedPath(path)}?ref=${encodeURIComponent(commit)}`, {
      headers: githubHeaders(await this.token(repository.id), 'application/vnd.github.raw+json'),
      signal,
    });
    if (response.status === 404) {
      await discardBody(response);
      return { id: item.id, reason: 'removed' };
    }
    if (!response.ok) {
      await discardBody(response);
      throw new GitHubApiError(response.status);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, this.filter.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    } catch (error) {
      if (error instanceof ReadCapExceeded) return { id: item.id, reason: 'removed' };
      throw error;
    }
    const ref: SourceRef = {
      kind: 'github',
      title: path,
      path,
      url: `https://github.com/${repository.fullName}/blob/${commit}/${encodedPath(path)}`,
      version: commit,
      readAt: new Date().toISOString(),
    };
    const mediaType = MEDIA_TYPES[extensionOf(path)];
    return { item, content: mediaType === undefined ? { text: new TextDecoder().decode(bytes) } : { bytes, mediaType }, ref };
  }

  /**
   * What a push to `after` changed, from the listing at `after` (read here when the caller holds none) against the
   * blobs read before (`cursor`: the JSON of each path's blob). A push's own commit lists are never read, so a force
   * push, or a push of more commits than its event lists, is read like any other. A push to another branch than the
   * default answers no change and the cursor it was given.
   */
  async changesSince(cursor: string | null, selection: GitHubChangesSelection, signal?: AbortSignal): Promise<SourceChanges> {
    const id = Number(selection.ids[0]);
    const repository = this.repository(id);
    if (selection.ref !== undefined && selection.ref !== `refs/heads/${repository.defaultBranch}`) {
      return { changed: [], gone: [], cursor: cursor ?? '{}' };
    }
    const before = new Map<string, string>(Object.entries(cursor === null ? {} : (JSON.parse(cursor) as Record<string, string>)));
    const after = selection.after ?? (await this.head(id, signal));
    const blobs = selection.listing ?? (await this.listing(id, after, signal));
    const now = new Map(blobs.map((blob) => [blob.path, blob.sha]));
    const changed = blobs
      .filter((blob) => before.get(blob.path) !== blob.sha)
      .map((blob) => ({ id: `${id}:${blob.path}`, title: blob.path, size: blob.size, version: `${blob.sha}@${after}` }));
    const gone = [...before.keys()].filter((path) => !now.has(path)).map((path) => ({ id: `${id}:${path}`, reason: 'removed' as const }));
    return { changed, gone, cursor: JSON.stringify(Object.fromEntries(now)) };
  }

  /** Nothing to end here: an installation is removed by the app's own call (`uninstallInstallation`). */
  async revoke(): Promise<void> {
    // A link's connector holds no grant of its own; the app's installation outlives any one link.
  }
}
