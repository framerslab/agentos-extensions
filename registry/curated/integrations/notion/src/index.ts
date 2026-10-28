/**
 * @fileoverview Notion for a host that keeps its own grant. This first commit holds the library's names alone; the
 * flow and the page writer follow it.
 * @module agentos-ext-notion
 */

/** Thrown by every name until the library is written. */
function notBuilt(): never {
  throw new Error('not_built');
}

/** The OAuth flow of a public connection. */
export class NotionOAuthFlow {
  constructor() {
    notBuilt();
  }
}

/** A fixed fault. */
export class NotionFault extends Error {}

/** Writes a page. */
export function createNotionPage(): never {
  return notBuilt();
}

/** Plans a page's requests. */
export function planNotionPage(): never {
  return notBuilt();
}

/** A page's link. */
export function notionPageLink(): never {
  return notBuilt();
}
