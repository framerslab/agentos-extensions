/**
 * @fileoverview A repository's tree at a commit, read within a request budget, and the filter that keeps its
 * documentation. GitHub cuts a recursive tree past 100,000 entries or 7 MB and marks it `truncated`; such a tree is
 * read again one subtree at a time.
 * @module agentos-ext-github/documents/tree
 */

import { arrayOf, GITHUB_API_BASE, githubFetch, objectOf, stringIn } from '../app/http.js';

/** One file of a tree: its path from the repository's root, its blob and its size in bytes. */
export interface TreeBlob {
  path: string;
  sha: string;
  size: number;
}

/** What a repository's documentation is: the files kept and the bounds on reading them. Each has a default. */
export interface TreeFilter {
  /** The file extensions kept, with their dot ({@link DOCUMENT_EXTENSIONS} when absent). */
  extensions?: readonly string[];
  /** The folders skipped at any depth, by name ({@link SKIPPED_FOLDERS} when absent). */
  skipFolders?: readonly string[];
  /** At most this many files, in path order ({@link DEFAULT_MAX_FILES} when absent). */
  maxFiles?: number;
  /** A file larger than this is left out of a listing, and a read past it is answered gone ({@link DEFAULT_MAX_FILE_BYTES} when absent). */
  maxFileBytes?: number;
  /** At most this many tree requests to list one commit ({@link DEFAULT_MAX_TREE_REQUESTS} when absent). */
  maxTreeRequests?: number;
}

/** The documentation kept by default: Markdown, text, reStructuredText, HTML, PDF and Word files. */
export const DOCUMENT_EXTENSIONS: readonly string[] = ['.md', '.markdown', '.txt', '.rst', '.html', '.htm', '.pdf', '.docx'];

/** The folders skipped by default: dependencies, build output and vendored code. */
export const SKIPPED_FOLDERS: readonly string[] = ['node_modules', 'vendor', 'dist', 'build', '.git', 'third_party'];

/** The files kept by default. */
export const DEFAULT_MAX_FILES = 2_000;

/** The largest file kept by default: 10 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 10_485_760;

/** The tree requests one listing makes by default. */
export const DEFAULT_MAX_TREE_REQUESTS = 50;

/** A symbolic link's mode in a tree; its blob holds the link's target, not a document. */
const SYMLINK_MODE = '120000';

/** A tree that cannot be read within its request budget. */
export class TreeTooLarge extends Error {
  /** @param maxRequests The budget the tree needed more than. */
  constructor(readonly maxRequests: number) {
    super(`the tree needs more than ${maxRequests} requests to read`);
    this.name = 'TreeTooLarge';
  }
}

/** The budget of a tree read, the folders it never walks into, and its abort signal. */
export interface ReadTreeOptions {
  /** At most this many requests ({@link DEFAULT_MAX_TREE_REQUESTS} when absent). */
  maxRequests?: number;
  /** Folders, by name, whose files are left out and which a read by subtree never requests. */
  skipFolders?: readonly string[];
  signal?: AbortSignal;
}

/** One entry of a tree answer. */
interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  mode: string;
  size: number | null;
}

function entryOf(value: unknown): TreeEntry {
  const fields = objectOf(value, 'a tree entry');
  return {
    path: stringIn(fields, 'path', 'a tree entry'),
    type: stringIn(fields, 'type', 'a tree entry'),
    sha: stringIn(fields, 'sha', 'a tree entry'),
    mode: typeof fields.mode === 'string' ? fields.mode : '',
    size: typeof fields.size === 'number' ? fields.size : null,
  };
}

/** A file's extension with its dot, in lower case, or `''` when its name has none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function inSkippedFolder(path: string, skip: ReadonlySet<string>): boolean {
  return path.split('/').slice(0, -1).some((folder) => skip.has(folder));
}

/**
 * Every file of a repository's tree at a commit (symbolic links aside). The tree is asked for recursively; when GitHub
 * answers it truncated, its top level is read and each subtree is asked for the same way, so only the parts too large
 * for one answer cost a request per folder. Each request counts against `maxRequests`, and the read throws
 * {@link TreeTooLarge} rather than make one more.
 *
 * @param fetchImpl The fetch the tree is read with.
 * @param token An installation token that reads the repository.
 * @param repo The repository's full name, `owner/name`.
 * @param commit The commit whose tree is read.
 * @param apiBase GitHub's REST API, or a stand-in's address in tests.
 * @param options The request budget, the folders skipped and an abort signal.
 */
export async function readTree(
  fetchImpl: typeof fetch,
  token: string,
  repo: string,
  commit: string,
  apiBase: string = GITHUB_API_BASE,
  options: ReadTreeOptions = {},
): Promise<TreeBlob[]> {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_TREE_REQUESTS;
  const skip = new Set(options.skipFolders ?? []);
  const blobs: TreeBlob[] = [];
  let requests = 0;

  const read = async (sha: string, recursive: boolean): Promise<{ truncated: boolean; entries: TreeEntry[] }> => {
    if (requests >= maxRequests) throw new TreeTooLarge(maxRequests);
    requests += 1;
    const url = `${apiBase}/repos/${repo}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`;
    const answer = objectOf(await githubFetch(fetchImpl, url, { token, signal: options.signal }), 'a tree');
    return { truncated: answer.truncated === true, entries: arrayOf(answer.tree, 'a tree').map(entryOf) };
  };

  const keep = (entry: TreeEntry, path: string): void => {
    if (entry.type === 'blob' && entry.mode !== SYMLINK_MODE && !inSkippedFolder(path, skip)) {
      blobs.push({ path, sha: entry.sha, size: entry.size ?? 0 });
    }
  };

  const walk = async (sha: string, prefix: string): Promise<void> => {
    const whole = await read(sha, true);
    if (!whole.truncated) {
      for (const entry of whole.entries) keep(entry, `${prefix}${entry.path}`);
      return;
    }
    const top = await read(sha, false);
    for (const entry of top.entries) {
      if (entry.type === 'tree') {
        if (!skip.has(entry.path)) await walk(entry.sha, `${prefix}${entry.path}/`);
      } else {
        keep(entry, `${prefix}${entry.path}`);
      }
    }
  };

  await walk(commit, '');
  return blobs;
}

/**
 * The filter that keeps a tree's documentation: the extensions kept, nothing under a skipped folder, nothing past the
 * size cap, in path order, at most `maxFiles`.
 */
export function pathFilter(filter: TreeFilter = {}): (blobs: readonly TreeBlob[]) => TreeBlob[] {
  const extensions = new Set((filter.extensions ?? DOCUMENT_EXTENSIONS).map((extension) => extension.toLowerCase()));
  const skip = new Set(filter.skipFolders ?? SKIPPED_FOLDERS);
  const maxFiles = filter.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = filter.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return (blobs) =>
    blobs
      .filter((blob) => extensions.has(extensionOf(blob.path)) && blob.size <= maxFileBytes && !inSkippedFolder(blob.path, skip))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, maxFiles);
}
