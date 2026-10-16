/**
 * @fileoverview Sequential discovery of an import selection's files and directories, from their metadata alone.
 * @module document-export/import/walk
 */

import { ImportBudget, ImportLimitError, type ImportLimits } from './limits.js';
import { ImportPathError, safeComponent } from './paths.js';
import type {
  DiscoveryFailure,
  DiscoverySkip,
  DiscoveredDirectory,
  DiscoveredFile,
  ImportDirectory,
  ImportDiscovery,
  ImportFile,
  ImportManifest,
  ImportRoot,
  ImportTreeNode,
} from './tree.js';

/** An internal fixed-code stop, carrying neither provider errors nor paths. */
class DiscoveryStop extends Error {
  /** Why discovery stopped, the same as the message. */
  readonly code: DiscoveryFailure;

  constructor(code: DiscoveryFailure) {
    super(code);
    this.name = 'DiscoveryStop';
    this.code = code;
  }
}

/** A root id: ASCII letters, digits, `_` and `-` only, so it never holds the colon that ends it inside an id. */
const ROOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Require cancellation to stop traversal before another capability is opened. */
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new DiscoveryStop('stopped');
}

/** A path identity scoped to a caller root; no locale or Unicode rewriting. */
function entryKey(rootId: string, parts: readonly string[]): string {
  return `${rootId}:${JSON.stringify(parts)}`;
}

/**
 * A directory's entries, with any error its provider throws reduced to `enumeration_failed` whatever the error's
 * class, so an adapter's failure is never read as a refusal by the walker's own checks. Closing this iterator closes
 * the provider's.
 */
async function* providerEntries(node: ImportDirectory, signal: AbortSignal): AsyncIterable<ImportTreeNode> {
  try {
    yield* node.entries(signal);
  } catch {
    throw new DiscoveryStop('enumeration_failed');
  }
}

/**
 * Lists the files and directories under `roots` from their metadata, one entry at a time, without opening any file
 * body. Each directory is admitted to the run's budget before it is asked for its entries, every leaf is counted,
 * and a link is listed as skipped and never followed. Every root id is checked before any root is visited.
 * Discovery ends at a run bound, an entry that cannot be enumerated, an unsafe directory name, a repeated path,
 * invalid roots or the caller's signal; the manifest then says why and keeps what was listed, and `sources` is
 * empty. An error a provider throws while listing a directory is reported as `enumeration_failed`, whatever its
 * class, or as `stopped` once the signal is aborted.
 *
 * @param roots The chosen files and directories, each with a caller-assigned id unique within this call.
 * @param limits The run's bounds, checked before any entry is requested.
 * @param signal Ends discovery before the next entry is requested.
 * @returns The review manifest and, only when it is complete, the readers of its ready files.
 * @throws {ImportLimitError} `invalid_limits` when `limits` are invalid: a configuration error, not the
 * selection's, raised before any entry is requested.
 */
export async function walkImportTree(
  roots: readonly ImportRoot[],
  limits: ImportLimits,
  signal: AbortSignal,
): Promise<ImportDiscovery> {
  const budget = new ImportBudget(limits);
  const files: DiscoveredFile[] = [];
  const directories: DiscoveredDirectory[] = [];
  const sources = new Map<string, ImportFile>();
  const seenPaths = new Set<string>();
  const seenRoots = new Set<string>();
  let status: ImportManifest['status'] = 'complete';
  let reason: DiscoveryFailure | null = null;

  /** Detect duplicate source paths without merging or inventing output identities. */
  function claim(rootId: string, parts: readonly string[]): string {
    const key = entryKey(rootId, parts);
    if (seenPaths.has(key)) throw new DiscoveryStop('duplicate_path');
    seenPaths.add(key);
    return key;
  }

  /** Visit one entry; directory admission precedes requesting its children. */
  async function visit(
    rootId: string,
    node: ImportTreeNode,
    parent: readonly string[],
    depth: number,
  ): Promise<void> {
    checkSignal(signal);
    if (node.kind === 'unavailable') throw new DiscoveryStop('enumeration_failed');
    if (node.kind === 'directory') {
      budget.addDirectory(depth);
      // An unsafe directory name throws here: the walk fails rather than skipping the directory or listing it empty.
      const parts = Object.freeze([...parent, safeComponent(node.name)]);
      claim(rootId, parts);
      directories.push({ rootId, parts, depth });
      checkSignal(signal);
      for await (const child of providerEntries(node, signal)) {
        checkSignal(signal);
        await visit(rootId, child, parts, child.kind === 'directory' ? depth + 1 : depth);
      }
      checkSignal(signal);
      return;
    }

    // A leaf is counted before its name is judged, so a skipped leaf still uses the run's budget.
    const sizeResult = budget.addFile(node.size, depth);
    let parts: readonly string[] | null = null;
    let skipped: DiscoverySkip | null = sizeResult === 'too_large' ? 'too_large' : null;
    try {
      parts = Object.freeze([...parent, safeComponent(node.name)]);
    } catch (error) {
      if (!(error instanceof ImportPathError)) throw error;
      skipped = 'unsafe_path';
    }
    if (node.kind === 'link' && skipped === null) skipped = 'link';
    const id = parts === null
      ? `${rootId}:invalid:${files.length}`
      : claim(rootId, parts);
    const row: DiscoveredFile = {
      id,
      rootId,
      parts,
      displayPath: [...parent, node.name].join('/'),
      bytes: node.size,
      admission: skipped === null ? 'ready' : 'skipped',
      reason: skipped,
    };
    files.push(row);
    if (node.kind === 'file' && skipped === null) sources.set(id, node);
  }

  try {
    checkSignal(signal);
    // Every root id is checked before any root is visited, so an invalid selection is refused as such and no
    // provider is asked for an entry first.
    for (const root of roots) {
      if (!ROOT_ID.test(root.id) || seenRoots.has(root.id)) throw new DiscoveryStop('invalid_roots');
      seenRoots.add(root.id);
    }
    for (const root of roots) {
      checkSignal(signal);
      await visit(root.id, root.node, [], 0);
    }
    checkSignal(signal);
  } catch (error) {
    if (signal.aborted || (error instanceof DiscoveryStop && error.code === 'stopped')) {
      status = 'stopped';
      reason = 'stopped';
    } else if (error instanceof ImportLimitError) {
      reason = error.code;
      status = error.code === 'invalid_metadata' || error.code === 'invalid_limits'
        ? 'failed' : 'limited';
    } else if (error instanceof ImportPathError) {
      status = 'failed';
      reason = 'unsafe_path';
    } else {
      // Anything else, such as a malformed entry, is reduced to a fixed reason: its message can name private paths.
      status = 'failed';
      reason = error instanceof DiscoveryStop ? error.code : 'enumeration_failed';
    }
    sources.clear();
  }

  return {
    manifest: {
      version: 1,
      status,
      reason,
      counts: budget.snapshot(),
      files,
      directories,
    },
    sources,
  };
}
