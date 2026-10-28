/**
 * @fileoverview Notion for a host that keeps its own grant: a public connection's OAuth on the core's redirect flow
 * (`NotionOAuthFlow`), and pages written as typed plain-text blocks inside Notion's request limits
 * (`createNotionPage`, `planNotionPage`, `notionPageLink`), with every failure a fixed `NotionFault`.
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
