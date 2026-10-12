/**
 * @fileoverview A person's own account as a source: what a connector lists, reads and reports as changed, and the
 * attribution every passage of it carries.
 * @module agentos-ext-account-sources/types
 */

/** Where a passage came from, as a page shows and links it. */
export interface SourceRef {
  /** `upload`, `web`, `dropbox`, `google_drive`, `github`, or a later connector's kind. */
  kind: string;
  title: string;
  /** The address a quote links to: a file at its commit, a Drive file, a web page. */
  url: string | null;
  /** The version read: a commit, a Drive file's version, a page's date. */
  version: string | null;
  /** When it was read, ISO 8601. */
  readAt: string;
  /** For a file in a repository: its path. */
  path?: string;
  /** For a passage: the first and last lines it spans, 1-based. */
  lines?: [number, number];
}

/** One readable item of an account. */
export interface SourceItem {
  /** The account's own id for it (a Drive file id; a repository id and a path). */
  id: string;
  title: string;
  /** What reading it would cost, when known. */
  size: number | null;
  version: string | null;
}

/** What a connector is asked to list. */
export interface SourceSelection {
  /** The account's ids the person chose (picked files, chosen repositories). */
  ids: readonly string[];
}

/** One item read: its bytes or text, its type, its attribution. */
export interface SourceRead {
  item: SourceItem;
  /** Text when the account exported text; bytes for the caller's loaders otherwise. */
  content: { text: string } | { bytes: Uint8Array; mediaType: string };
  ref: SourceRef;
}

/** An item that can no longer be read: removed, unshared, out of the grant. */
export interface SourceGone {
  id: string;
  reason: 'removed' | 'no_access' | 'not_owned';
}

/** What changed since a cursor. */
export interface SourceChanges {
  changed: SourceItem[];
  gone: SourceGone[];
  cursor: string;
}

/** A connector to a person's account. */
export interface AccountSourceConnector {
  readonly kind: string;
  /** Lists the selected items and those that can no longer be read. */
  list(selection: SourceSelection, signal?: AbortSignal): Promise<{ items: SourceItem[]; gone: SourceGone[] }>;
  /** Reads one item with its attribution or reports why it is gone. */
  read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone>;
  /** Lists changes to the selection since a cursor and answers the next cursor. */
  changesSince(cursor: string | null, selection: SourceSelection, signal?: AbortSignal): Promise<SourceChanges>;
  /** Ends the access the connector holds, where the account has a way to. */
  revoke(): Promise<void>;
}
