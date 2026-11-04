/**
 * @fileoverview The kinds of account the published connectors read or write, as a connector's `kind` and every
 * passage's `SourceRef.kind` name them.
 * @module agentos-ext-account-sources/kinds
 */

/**
 * The kinds the published connectors use: an upload, a web page, Dropbox, Google Drive, GitHub and Gmail, which they
 * read, Notion, whose connection writes the pages a person chose and reads none, and Slack, whose channels a
 * connection reads. `kind` stays an open string, so a later connector names its own.
 */
export const ACCOUNT_SOURCE_KINDS = Object.freeze(
  ['upload', 'web', 'dropbox', 'google_drive', 'github', 'gmail', 'notion', 'slack'] as const);

/** One of the kinds the published connectors use. */
export type AccountSourceKind = (typeof ACCOUNT_SOURCE_KINDS)[number];

const kinds: ReadonlySet<string> = new Set(ACCOUNT_SOURCE_KINDS);

/**
 * Whether a kind is one the published connectors use; a later connector's own kind answers false.
 *
 * @param kind - A connector's or a passage's kind.
 * @returns True for a kind of `ACCOUNT_SOURCE_KINDS`, compared exactly.
 */
export function isAccountSourceKind(kind: string): kind is AccountSourceKind {
  return kinds.has(kind);
}
