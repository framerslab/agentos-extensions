/**
 * @fileoverview A person's own account as a source: what a connector lists, reads and reports as changed, and the
 * attribution every passage of it carries.
 * @module agentos-ext-account-sources/types
 */

/** Where a passage came from, as a page shows and links it. */
export interface SourceRef {
  /**
   * One of `ACCOUNT_SOURCE_KINDS` (`upload`, `web`, `dropbox`, `google_drive`, `github`, `gmail`, `notion`, `slack`), or a
   * later connector's kind.
   */
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
  /**
   * How the connector lists where the ids leave the choice to it, such as Slack's `invited`, `public` and `all`
   * channel sets: a lower-case letter, then at most 31 lower-case letters, digits or underscores. Absent, the connector
   * lists by its own default; a connector that lists by ids alone ignores it.
   */
  mode?: string;
}

/** One item read: its bytes or text, its type, its attribution. */
export interface SourceRead {
  item: SourceItem;
  /** Text when the account exported text; bytes for the caller's loaders otherwise. */
  content: { text: string } | { bytes: Uint8Array; mediaType: string };
  ref: SourceRef;
}

/**
 * An item that can no longer be read: removed, unshared, out of the grant, or `too_large`, an item still in the account
 * and readable by the grant whose content is past the connector's byte cap, which a caller may keep its earlier copy of.
 */
export interface SourceGone {
  id: string;
  reason: 'removed' | 'no_access' | 'not_owned' | 'too_large';
}

/** What changed since a cursor. */
export interface SourceChanges {
  changed: SourceItem[];
  gone: SourceGone[];
  cursor: string;
}

/**
 * A connector to a person's account. A write-only connection, such as Notion's, which writes the pages a person chose
 * and reads none, lists nothing, reads nothing and reports no change.
 */
export interface AccountSourceConnector {
  /** One of `ACCOUNT_SOURCE_KINDS`, or a later connector's own kind. */
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
