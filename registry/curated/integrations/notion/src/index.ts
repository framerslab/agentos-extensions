/**
 * @fileoverview Notion for a host that keeps its own grant: a public connection's OAuth on the core's redirect flow
 * (`NotionOAuthFlow`), and pages written as typed plain-text blocks inside Notion's request limits
 * (`createNotionPage`, `planNotionPage`, `notionPageLink`), and the pages a connection was shared read as an account
 * source (`NotionReadConnector`). An input refused before a call, every failure of a page's write and every failure of
 * a read is a fixed `NotionFault`; a refused exchange, refresh or revocation is the core's `OAuthGrantRefused`, with the
 * status and Notion's OAuth code.
 * @module agentos-ext-notion
 */

export { NotionFault, type NotionFailure, type NotionFaultDetails } from './faults.js';
export {
  NOTION_ENDPOINTS, NOTION_VERSION, NotionOAuthFlow, type NotionEndpoints, type NotionGrantMetadata, type NotionOAuthClient,
  type NotionOAuthOptions,
} from './oauth.js';
export {
  NOTION_LIMITS, createNotionPage, notionPageLink, planNotionPage, type NotionBlockKind, type NotionPage, type NotionPageInput,
  type NotionPagePlan, type NotionPagesOptions, type NotionTextBlock,
} from './pages.js';
export {
  NOTION_READ_KIND, NotionReadConnector, type NotionPageItem, type NotionPageParent, type NotionReadMethod,
  type NotionReadOptions,
} from './read.js';
