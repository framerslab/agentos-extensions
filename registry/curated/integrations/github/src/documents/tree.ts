/**
 * @fileoverview A repository's tree at a commit, read within a request budget, and the filter that keeps its
 * documentation. GitHub cuts a recursive tree past 100,000 entries or 7 MB and marks it `truncated`; such a tree is
 * read again one subtree at a time, and a level GitHub cuts short even when asked for alone is refused whole.
 * @module agentos-ext-github/documents/tree
 */

import { arrayOf, GITHUB_API_BASE, githubFetch, objectOf, repositoryPath, stringIn } from '../app/http.js';

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
  /**
   * Code files kept too: the source files of {@link CODE_EXTENSIONS} beside `extensions`, under the same bounds, a
   * generated one left out ({@link isGeneratedCode}). Off when absent, so a repository's code is read only when its
   * reader asks for it.
   */
  includeCode?: boolean;
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

/**
 * The source files a filter that includes code keeps beside its documentation (`includeCode`): program source in the
 * common languages, shell scripts, SQL, GraphQL and Protocol Buffers schemas, Terraform and style sheets, each read as
 * UTF-8 text. Data and configuration (JSON, YAML, XML, CSV) and binary files are not code here, and stay out.
 */
export const CODE_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
  '.scala', '.swift', '.m', '.mm', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.fs', '.php', '.pl',
  '.pm', '.lua', '.r', '.jl', '.dart', '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.hs', '.ml', '.mli', '.elm',
  '.vue', '.svelte', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.graphql', '.gql', '.proto', '.tf', '.css', '.scss',
  '.sass', '.less',
];

/**
 * The endings of code files a tool writes rather than a person, left out of a filter that includes code: minified and
 * bundled scripts and style sheets, and the files the Protocol Buffers, Dart and similar generators write. The folders
 * of build output and dependencies are skipped already ({@link SKIPPED_FOLDERS}), and lock files carry no code
 * extension.
 */
export const GENERATED_CODE_ENDINGS: readonly string[] = [
  '.min.js', '.min.mjs', '.min.cjs', '.min.css', '.bundle.js', '.bundle.mjs', '.bundle.css', '.chunk.js', '.chunk.mjs',
  '.chunk.css', '.pb.go', '.pb.cc', '.pb.h', '_pb2.py', '_pb2_grpc.py', '.g.dart', '.freezed.dart', '.generated.ts',
];

/** True for a code file a tool wrote, by its name's ending ({@link GENERATED_CODE_ENDINGS}), in any case. */
export function isGeneratedCode(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return GENERATED_CODE_ENDINGS.some((ending) => name.endsWith(ending));
}

/** The files kept by default. */
export const DEFAULT_MAX_FILES = 2_000;

/** The largest file kept by default: 10 MiB. */
export const DEFAULT_MAX_FILE_BYTES = 10_485_760;

/** The tree requests one listing makes by default. */
export const DEFAULT_MAX_TREE_REQUESTS = 50;

/** A symbolic link's mode in a tree; its blob holds the link's target, not a document. */
const SYMLINK_MODE = '120000';

/**
 * Why a tree cannot be read whole: `budget` when it needs more requests than its budget, `truncated` when GitHub cut
 * short a level asked for without recursion, which no budget reads whole.
 */
export type TreeTooLargeReason = 'budget' | 'truncated';

/**
 * A tree that cannot be read whole: past its request budget, or holding a folder GitHub cuts short even when asked for
 * alone. Neither answers a part of the tree, since a file left out would read as removed.
 */
export class TreeTooLarge extends Error {
  /**
   * @param maxRequests The request budget of the read.
   * @param reason Why the tree cannot be read whole; `budget` when absent.
   */
  constructor(
    readonly maxRequests: number,
    readonly reason: TreeTooLargeReason = 'budget',
  ) {
    super(reason === 'budget' ? `the tree needs more than ${maxRequests} requests to read` : 'GitHub cut a folder of the tree short even when asked for alone');
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
 * {@link TreeTooLarge} (`budget`) rather than make one more. A level GitHub answers truncated without recursion as well
 * throws {@link TreeTooLarge} (`truncated`) at that answer, before any folder under it is asked for: the tree answer's
 * `truncated` field can be set on any answer, and a part of the tree would leave out files that then read as removed.
 *
 * Name the repository by its id. A full name reads whatever repository holds that name when the tree is asked for: a
 * renamed repository's old name can be taken again, and an account's old login claimed by another account, which ends
 * GitHub's redirects to the repository; and GitHub answers a public repository's tree to any token, an installation
 * token narrowed to other repositories included.
 *
 * @param fetchImpl The fetch the tree is read with.
 * @param token An installation token that reads the repository.
 * @param repository The repository's id, read at `/repositories/<id>`, or its full name, `owner/name`.
 * @param commit The commit whose tree is read.
 * @param apiBase GitHub's REST API, or a stand-in's address in tests.
 * @param options The request budget, the folders skipped and an abort signal.
 * @throws TypeError before any request when `repository` is a number that is not a positive integer.
 */
export async function readTree(
  fetchImpl: typeof fetch,
  token: string,
  repository: number | string,
  commit: string,
  apiBase: string = GITHUB_API_BASE,
  options: ReadTreeOptions = {},
): Promise<TreeBlob[]> {
  const address = `${apiBase}/${repositoryPath(repository)}`;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_TREE_REQUESTS;
  const skip = new Set(options.skipFolders ?? []);
  const blobs: TreeBlob[] = [];
  let requests = 0;

  const read = async (sha: string, recursive: boolean): Promise<{ truncated: boolean; entries: TreeEntry[] }> => {
    if (requests >= maxRequests) throw new TreeTooLarge(maxRequests);
    requests += 1;
    const url = `${address}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`;
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
    // A level cut short read on would leave out the files past the cut, which would then read as removed.
    if (top.truncated) throw new TreeTooLarge(maxRequests, 'truncated');
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

/** Blobs in path order. */
function byPath(a: TreeBlob, b: TreeBlob): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The filter that keeps a tree's documentation: the extensions kept, and with `includeCode` the code extensions beside
 * them; nothing under a skipped folder, nothing past the size cap, at most `maxFiles`, in path order. With code asked
 * for, a code file a tool wrote is left out, whatever `extensions` names, and the documentation keeps its places under
 * the cap first: the documentation paths first in path order, then the code paths in path order in the room left, so
 * turning code on never drops a document a listing held.
 */
export function pathFilter(filter: TreeFilter = {}): (blobs: readonly TreeBlob[]) => TreeBlob[] {
  const documents = new Set((filter.extensions ?? DOCUMENT_EXTENSIONS).map((extension) => extension.toLowerCase()));
  const code = new Set<string>(filter.includeCode === true ? CODE_EXTENSIONS : []);
  const skip = new Set(filter.skipFolders ?? SKIPPED_FOLDERS);
  const maxFiles = filter.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = filter.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return (blobs) => {
    const readable = blobs.filter((blob) => blob.size <= maxFileBytes && !inSkippedFolder(blob.path, skip));
    // Code a tool wrote is left out once code is asked for, under any extension; the documentation's own come first.
    const written = readable.filter((blob) => !(code.has(extensionOf(blob.path)) && isGeneratedCode(blob.path)));
    const documentation = written.filter((blob) => documents.has(extensionOf(blob.path))).sort(byPath).slice(0, maxFiles);
    const room = maxFiles - documentation.length;
    const sources = written.filter((blob) => !documents.has(extensionOf(blob.path)) && code.has(extensionOf(blob.path))).sort(byPath);
    return [...documentation, ...sources.slice(0, Math.max(room, 0))].sort(byPath);
  };
}
