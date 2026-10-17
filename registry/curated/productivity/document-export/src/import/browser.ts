/**
 * @fileoverview Browser file and folder selections adapted to the import walker's structural sources. Each browser
 * capability is typed by the structure this module calls, so the package compiles without DOM types: a page passes
 * its own `File`, file-system handle, entry, drop and picker objects, and their methods are called on the objects
 * that own them.
 * @module document-export/import/browser
 */

import { ImportBudget, type ImportLimits } from './limits.js';
import { relativeParts } from './paths.js';
import type { ImportFile, ImportRoot, ImportTreeNode } from './tree.js';

/** The bytes one body read asks for. Reads are taken one at a time, so this is also the most held at once. */
const SLICE_BYTES = 65_536;

/** The name given to a dropped item that no provider could describe; the walker refuses it without listing it. */
const UNREADABLE = 'unreadable entry';

/** The `File` subset this module reads, so the package needs no DOM types. A browser `File` satisfies it. */
export interface BrowserFile {
  /** The file's own name, one path component. */
  readonly name: string;
  /** The file's size in bytes, fixed when the browser handed the file over. */
  readonly size: number;
  /** The file's path from the chosen directory's own name, set by a directory input; empty or absent otherwise. */
  readonly webkitRelativePath?: string;
  /** A view of bytes `start` up to `end`. Reading a view is the only access to the file's body. */
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** A file-system handle, by its structure. The browser owns any permission prompt. */
export interface BrowserHandle {
  /** Whether the handle names a file or a directory. */
  readonly kind: 'file' | 'directory';
  /** The entry's own name, one path component. */
  readonly name: string;
  /** A file handle's snapshot of its file, which carries metadata; its bytes are read separately. */
  getFile?(): Promise<BrowserFile>;
  /** A directory handle's children, each once. */
  values?(): AsyncIterable<BrowserHandle>;
}

/** A legacy directory reader: each call answers the next batch, and an empty batch means every entry was given. */
export interface LegacyReader {
  /** Answers the next batch of entries through `resolve`, or an error through `reject`. */
  readEntries(resolve: (entries: LegacyEntry[]) => void, reject: (error: unknown) => void): void;
}

/** A legacy file or directory entry. Its capabilities are inspected, never guessed from a file's size. */
export interface LegacyEntry {
  /** The entry's own name, one path component. */
  readonly name: string;
  /** Whether the entry is a file. */
  readonly isFile: boolean;
  /** Whether the entry is a directory. */
  readonly isDirectory: boolean;
  /** A file entry's snapshot of its file. */
  file?(resolve: (file: BrowserFile) => void, reject: (error: unknown) => void): void;
  /** A directory entry's reader of its children. */
  createReader?(): LegacyReader;
}

/** One item of a drop. Its getters answer only while the drop event is being handled. */
export interface BrowserDropItem {
  /** `file` for a dropped file or directory; an item of any other kind, such as dragged text, is ignored. */
  readonly kind: string;
  /** The item's file-system handle, where the browser offers one. */
  getAsFileSystemHandle?(): Promise<BrowserHandle | null>;
  /** The item's legacy entry. */
  webkitGetAsEntry?(): LegacyEntry | null;
  /** The item as a plain file, used only when no directory provider describes it. */
  getAsFile?(): BrowserFile | null;
}

/** A drop's items and files as array-like lists, so a browser's own lists pass without first being copied. */
export interface BrowserDrop {
  /** The drop's items. */
  readonly items: ArrayLike<BrowserDropItem>;
  /** The drop's files, read only when no item is a file. */
  readonly files: ArrayLike<BrowserFile>;
}

/** What {@link chooseDirectory} needs from the page. */
export interface DirectoryPickerPort {
  /** Whether the page runs in a secure context; the picker is offered only there. */
  readonly secureContext: boolean;
  /** The browser's directory picker, bound to its window, where the browser has one. */
  showDirectoryPicker?(options: { mode: 'read' }): Promise<BrowserHandle>;
}

/**
 * The answer of {@link chooseDirectory}. `cancelled` leaves the caller's current selection as it was, `unsupported`
 * means that no picker can be offered here, and `failed` that the picker failed or answered with something other
 * than a directory.
 */
export type DirectorySelection =
  | { readonly status: 'selected'; readonly roots: readonly ImportRoot[] }
  | { readonly status: 'cancelled' | 'unsupported' }
  | { readonly status: 'failed'; readonly reason: 'provider_failed' };

/** The fixed codes a {@link BrowserSelectionError} carries. */
export type BrowserSelectionCode =
  | 'stopped'
  | 'provider_failed'
  | 'duplicate_path'
  | 'relative_path_missing'
  | 'selection_limit';

/** A refusal by these adapters. Its message is its code alone, so a provider's own error text never reaches a log. */
export class BrowserSelectionError extends Error {
  /** Why the adapter refused, the same as the message. */
  readonly code: BrowserSelectionCode;

  constructor(code: BrowserSelectionCode) {
    super(code);
    this.name = 'BrowserSelectionError';
    this.code = code;
  }
}

/** Throws `stopped` once `signal` is aborted, so no further browser call is started. */
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new BrowserSelectionError('stopped');
}

/**
 * Waits for a browser call, but rejects with `stopped` as soon as `signal` aborts, so a call that never answers
 * cannot hold a stop back. A browser call cannot be withdrawn: it may still finish, and its result or error is then
 * dropped.
 */
function settle<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(new BrowserSelectionError('stopped'));
    pending.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

/** Asks an iterator to release its resources without waiting, since a read still pending inside it may never end. */
function close(iterator: AsyncIterator<unknown>): void {
  try {
    void iterator.return?.().then(undefined, () => {});
  } catch {
    // An iterator whose close throws has nothing further to release here.
  }
}

/**
 * A chosen file as the walker's source. Discovery reads only its name and size; its body is read in slices, one at a
 * time, when the caller asks for chunks after review, with `signal` checked between them.
 */
function source(file: BrowserFile): ImportFile {
  const size = file.size;
  return {
    kind: 'file',
    name: file.name,
    size,
    async *chunks(signal: AbortSignal) {
      for (let offset = 0; offset < size; offset += SLICE_BYTES) {
        check(signal);
        const length = Math.min(SLICE_BYTES, size - offset);
        let buffer: ArrayBuffer;
        try {
          buffer = await settle(file.slice(offset, offset + length).arrayBuffer(), signal);
        } catch {
          // A stop is reported as such; any other failure is the provider's, under a fixed code.
          check(signal);
          throw new BrowserSelectionError('provider_failed');
        }
        check(signal);
        // A file that changed after it was chosen can answer fewer bytes: it is refused, never read short.
        if (buffer.byteLength !== length) throw new BrowserSelectionError('provider_failed');
        yield new Uint8Array(buffer);
      }
      check(signal);
    },
  };
}

/** A handle as the walker's source: a file handle's file is asked for now, a directory's children when it is listed. */
async function fromHandle(handle: BrowserHandle, signal: AbortSignal): Promise<ImportTreeNode> {
  check(signal);
  if (handle.kind === 'file') {
    if (!handle.getFile) return { kind: 'unavailable', name: handle.name };
    const file = await settle(handle.getFile(), signal);
    check(signal);
    return source(file);
  }
  return {
    kind: 'directory',
    name: handle.name,
    async *entries(active: AbortSignal) {
      check(active);
      if (!handle.values) throw new BrowserSelectionError('provider_failed');
      const children = handle.values()[Symbol.asyncIterator]();
      let finished = false;
      try {
        for (;;) {
          const step = await settle(children.next(), active);
          check(active);
          if (step.done) {
            finished = true;
            break;
          }
          yield await fromHandle(step.value, active);
        }
      } finally {
        if (!finished) close(children);
      }
      check(active);
    },
  };
}

/** A legacy entry as the walker's source: a file entry's file is asked for now, a directory's batches when listed. */
async function fromEntry(entry: LegacyEntry, signal: AbortSignal): Promise<ImportTreeNode> {
  check(signal);
  if (entry.isFile && !entry.isDirectory && entry.file) {
    const file = await settle(new Promise<BrowserFile>((resolve, reject) => entry.file!(resolve, reject)), signal);
    check(signal);
    return source(file);
  }
  if (!entry.isDirectory || entry.isFile || !entry.createReader) return { kind: 'unavailable', name: entry.name };
  return {
    kind: 'directory',
    name: entry.name,
    async *entries(active: AbortSignal) {
      check(active);
      const reader = entry.createReader!();
      for (;;) {
        check(active);
        const batch = await settle(
          new Promise<LegacyEntry[]>((resolve, reject) => reader.readEntries(resolve, reject)),
          active,
        );
        check(active);
        // Chromium answers at most 100 entries a call, so a directory is complete only at an empty batch.
        if (batch.length === 0) return;
        for (const child of batch) {
          check(active);
          yield await fromEntry(child, active);
        }
      }
    },
  };
}

/**
 * The roots of a multiple-file input, one for each file in the list's order. Files that share a name stay separate
 * roots, with ids `file_0`, `file_1` and so on. Each file is admitted to a budget first, so a list past the caller's
 * bounds is refused before any root is made.
 *
 * @param files The input's files.
 * @param limits The run's bounds.
 * @returns One root per file.
 * @throws {ImportLimitError} `invalid_limits` for invalid limits, `invalid_metadata` for a size that is not a whole
 * number, and `files_limit` or `bytes_limit` when the files pass the caller's bounds.
 */
export function fileRoots(files: ArrayLike<BrowserFile>, limits: ImportLimits): ImportRoot[] {
  const budget = new ImportBudget(limits);
  const roots: ImportRoot[] = [];
  for (let n = 0; n < files.length; n += 1) {
    const file = files[n]!;
    budget.addFile(file.size, 0);
    roots.push({ id: `file_${n}`, node: source(file) });
  }
  return roots;
}

/** A directory rebuilt from a directory input's relative paths. */
interface InputDirectory {
  /** The directory's own name. */
  readonly name: string;
  /** Its directories and files by name, in the order the input first named them. */
  readonly children: Map<string, InputDirectory | ImportFile>;
}

/** Whether a rebuilt child is a directory rather than a file. */
function isInputDirectory(node: InputDirectory | ImportFile): node is InputDirectory {
  return 'children' in node;
}

/** A rebuilt directory as the walker's source. */
function inputNode(directory: InputDirectory): ImportTreeNode {
  return {
    kind: 'directory',
    name: directory.name,
    async *entries(signal: AbortSignal) {
      for (const child of directory.children.values()) {
        check(signal);
        yield isInputDirectory(child) ? inputNode(child) : child;
      }
      check(signal);
    },
  };
}

/**
 * The roots of a directory input, rebuilt from each file's `webkitRelativePath`: one root for each top-level
 * directory named, with ids `folder_0`, `folder_1` and so on. Only the directories some returned file names are
 * rebuilt, so an empty directory the input did not return is never claimed. Each file and directory is admitted to a
 * budget as it is met, so a selection past the caller's bounds is refused before any root is made.
 *
 * @param files The input's files, each with its relative path.
 * @param limits The run's bounds.
 * @returns One root per top-level directory.
 * @throws {ImportPathError} `unsafe_path` when a path has an unsafe component.
 * @throws {BrowserSelectionError} `relative_path_missing` when a file has no relative path or one that does not end
 * in its name below a directory, and `duplicate_path` when two files share a path or one file's path is another's
 * directory.
 * @throws {ImportLimitError} When the limits are invalid, or the files or directories pass the caller's bounds.
 */
export function relativeFileRoots(files: ArrayLike<BrowserFile>, limits: ImportLimits): ImportRoot[] {
  const budget = new ImportBudget(limits);
  const roots = new Map<string, InputDirectory>();
  for (let n = 0; n < files.length; n += 1) {
    const file = files[n]!;
    if (!file.webkitRelativePath) throw new BrowserSelectionError('relative_path_missing');
    const parts = relativeParts(file.webkitRelativePath);
    if (parts.length < 2 || parts[parts.length - 1] !== file.name) {
      throw new BrowserSelectionError('relative_path_missing');
    }
    // A file sits in its deepest directory: one directly in the chosen directory is at depth 0.
    budget.addFile(file.size, parts.length - 2);
    let parent: InputDirectory | undefined;
    for (let level = 0; level < parts.length - 1; level += 1) {
      const name = parts[level]!;
      const existing = parent === undefined ? roots.get(name) : parent.children.get(name);
      if (existing === undefined) {
        budget.addDirectory(level);
        const created: InputDirectory = { name, children: new Map() };
        if (parent === undefined) roots.set(name, created);
        else parent.children.set(name, created);
        parent = created;
      } else if (isInputDirectory(existing)) {
        parent = existing;
      } else {
        // A file already holds this path, so it cannot also be a directory.
        throw new BrowserSelectionError('duplicate_path');
      }
    }
    // The loop ran at least once, since a path here has a directory and a name.
    if (parent!.children.has(file.name)) throw new BrowserSelectionError('duplicate_path');
    parent!.children.set(file.name, source(file));
  }
  return [...roots.values()].map((directory, n) => ({ id: `folder_${n}`, node: inputNode(directory) }));
}

/** What a drop item answered while the drop event was being handled. */
interface CapturedItem {
  /** The item's handle request, settling to null when it fails. */
  readonly handle: Promise<BrowserHandle | null> | null;
  /** The item's legacy entry. */
  readonly entry: LegacyEntry | null;
  /** The item as a plain file. */
  readonly file: BrowserFile | null;
  /** Whether a getter threw or the handle request failed; read once the handle has settled. */
  failed(): boolean;
}

/** Calls each of a drop item's getters once, in the drop event's tick, and keeps whatever they answer. */
function capture(item: BrowserDropItem): CapturedItem {
  let failed = false;
  let handle: Promise<BrowserHandle | null> | null = null;
  let entry: LegacyEntry | null = null;
  let file: BrowserFile | null = null;
  try {
    if (item.getAsFileSystemHandle) {
      handle = item.getAsFileSystemHandle().catch(() => {
        failed = true;
        return null;
      });
    }
  } catch {
    failed = true;
  }
  try {
    entry = item.webkitGetAsEntry?.() ?? null;
  } catch {
    failed = true;
  }
  try {
    file = item.getAsFile?.() ?? null;
  } catch {
    failed = true;
  }
  return { handle, entry, file, failed: () => failed };
}

/** The source a provider opens for a file, or null when it cannot open one; a stop is passed on. */
async function attempt(pending: Promise<ImportTreeNode>, signal: AbortSignal): Promise<ImportTreeNode | null> {
  let node: ImportTreeNode;
  try {
    node = await pending;
  } catch {
    check(signal);
    return null;
  }
  return node.kind === 'unavailable' ? null : node;
}

/**
 * Resolves a captured item to its source. The first provider that answers, the handle before the entry, decides
 * whether the item is a directory, and a directory is left to the walker to list, never replaced by another
 * provider's answer. A file one provider cannot open is tried through the item's other providers. The plain file
 * stands in only for an item a provider named as a file, or one no provider failed on, so a folder that could not be
 * opened never comes back as an apparent empty file.
 */
async function resolveItem(item: CapturedItem, signal: AbortSignal): Promise<ImportTreeNode> {
  try {
    const native = item.handle === null ? null : await settle(item.handle, signal);
    check(signal);
    const { entry } = item;
    const entryFile = entry !== null && entry.isFile && !entry.isDirectory;
    if (native?.kind === 'directory') return await fromHandle(native, signal);
    // With no handle, an entry that is not a file is a directory to list, or unavailable when it names neither.
    if (native === null && entry !== null && !entryFile) return await fromEntry(entry, signal);
    if (native !== null) {
      const opened = await attempt(fromHandle(native, signal), signal);
      if (opened) return opened;
    }
    if (entry !== null && entryFile) {
      const opened = await attempt(fromEntry(entry, signal), signal);
      if (opened) return opened;
    }
    if (item.file && (native !== null || entryFile || !item.failed())) return source(item.file);
  } catch {
    // A stop is reported as such; any other failure leaves the item unavailable, with no provider text kept.
    check(signal);
  }
  return { kind: 'unavailable', name: UNREADABLE };
}

/**
 * The roots of a drop, one for each dropped file or directory, with ids `drop_0`, `drop_1` and so on, or, when no
 * item is a file, those of the drop's file list. Call it inside the drop event's handler, before any await of the
 * handler's own: everything up to this function's first wait runs in that tick, while the browser's drag data store
 * is readable. Each file item's getters are called there, all at once, which is the one fan-out and obtains
 * capabilities, never bodies. The items are then resolved one at a time, a handle before an entry before a plain
 * file. A directory a provider names is never replaced by another provider's answer, while a file one provider cannot
 * open is tried through the others. A plain file stands in only for an item a provider named as a file or one no
 * provider failed on, and an item no provider can open becomes an unavailable root, which the walker reports as
 * `enumeration_failed`.
 *
 * Every refusal comes through the returned promise.
 *
 * @param drop The drop event's items and files.
 * @param limits The run's bounds; a drop of more file items than `maxFiles` and `maxDirectories` together is refused
 * before any getter is called.
 * @param signal Ends the resolution before the next browser call, or during a pending one.
 * @returns The drop's roots, for `walkImportTree`.
 * @throws {BrowserSelectionError} Rejects with `selection_limit` for too many file items and `stopped` once the
 * signal is aborted.
 * @throws {ImportLimitError} Rejects for invalid limits, or when the drop's file list passes the caller's bounds.
 */
export async function captureDrop(
  drop: BrowserDrop,
  limits: ImportLimits,
  signal: AbortSignal,
): Promise<ImportRoot[]> {
  // Checks the limits before any getter is called.
  void new ImportBudget(limits);
  check(signal);
  let fileItems = 0;
  for (let n = 0; n < drop.items.length; n += 1) {
    if (drop.items[n]!.kind === 'file') fileItems += 1;
  }
  // Each dropped file or directory takes at least one file or directory from the run's budget.
  if (fileItems > limits.maxFiles + limits.maxDirectories) throw new BrowserSelectionError('selection_limit');
  const captured: CapturedItem[] = [];
  for (let n = 0; n < drop.items.length; n += 1) {
    const item = drop.items[n]!;
    if (item.kind === 'file') captured.push(capture(item));
  }
  // The drop's file list is read in the same tick, and only when no item is a file.
  if (captured.length === 0) return fileRoots(drop.files, limits);
  const roots: ImportRoot[] = [];
  for (let n = 0; n < captured.length; n += 1) {
    check(signal);
    roots.push({ id: `drop_${n}`, node: await resolveItem(captured[n]!, signal) });
  }
  check(signal);
  return roots;
}

/** Whether `error` is the `AbortError` a browser answers when the person dismisses a picker. */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/**
 * Opens the browser's directory picker for read access alone; call it from the person's own action, which the picker
 * needs. No persistent permission is requested. The answer is `selected` with one root, `folder_0`, whose children
 * are listed only when the walker reaches them; `unsupported` outside a secure context or without a picker;
 * `cancelled` when the person dismisses the picker or the signal ends the wait; and `failed` when the picker fails or
 * answers with something other than a directory.
 *
 * @param port The page's secure-context flag and picker.
 * @param signal Ends the wait for the picker.
 * @returns The selection, never a rejection.
 */
export async function chooseDirectory(port: DirectoryPickerPort, signal: AbortSignal): Promise<DirectorySelection> {
  if (!port.secureContext || !port.showDirectoryPicker) return { status: 'unsupported' };
  if (signal.aborted) return { status: 'cancelled' };
  try {
    const handle = await settle(port.showDirectoryPicker({ mode: 'read' }), signal);
    if (signal.aborted) return { status: 'cancelled' };
    if (handle.kind !== 'directory') return { status: 'failed', reason: 'provider_failed' };
    return { status: 'selected', roots: [{ id: 'folder_0', node: await fromHandle(handle, signal) }] };
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return { status: 'cancelled' };
    return { status: 'failed', reason: 'provider_failed' };
  }
}
