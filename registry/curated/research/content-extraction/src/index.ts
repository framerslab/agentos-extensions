// @ts-nocheck
/**
 * @fileoverview Content Extraction Extension for AgentOS.
 *
 * Provides 5 tools for extracting content from URLs, YouTube videos,
 * Wikipedia articles, PDF documents, and structured web data.
 *
 * @module @framers/agentos-ext-content-extraction
 */

import { ContentExtractionService } from './ContentExtractionService.js';
import { ExtractUrlTool } from './tools/url.js';
import { ExtractYouTubeTool } from './tools/youtube.js';
import { ExtractWikipediaTool } from './tools/wikipedia.js';
import { ExtractPdfTool } from './tools/pdf.js';
import { ExtractStructuredTool } from './tools/structured.js';
import { PACKAGE_VERSION } from './packageVersion.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ContentExtractionOptions {
  secrets?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Extension Context (matches AgentOS extension protocol)
// ---------------------------------------------------------------------------

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{ id: string; kind: string; priority?: number; payload: unknown }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const service = new ContentExtractionService();

  const urlTool = new ExtractUrlTool(service);
  const youtubeTool = new ExtractYouTubeTool(service);
  const wikipediaTool = new ExtractWikipediaTool(service);
  const pdfTool = new ExtractPdfTool(service);
  const structuredTool = new ExtractStructuredTool(service);

  return {
    name: '@framers/agentos-ext-content-extraction',
    version: PACKAGE_VERSION,
    descriptors: [
      { id: 'extractUrl', kind: 'tool', priority: 50, payload: urlTool },
      { id: 'extractYoutube', kind: 'tool', priority: 50, payload: youtubeTool },
      { id: 'extractWikipedia', kind: 'tool', priority: 50, payload: wikipediaTool },
      { id: 'extractPdf', kind: 'tool', priority: 50, payload: pdfTool },
      { id: 'extractStructured', kind: 'tool', priority: 50, payload: structuredTool },
    ],
    onActivate: async () => {
      await service.initialize();
    },
    onDeactivate: async () => {
      await service.shutdown();
    },
  };
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

export { ContentExtractionService } from './ContentExtractionService.js';
export type {
  UrlExtractionResult,
  YouTubeExtractionResult,
  WikipediaExtractionResult,
  PdfExtractionResult,
  StructuredExtractionResult,
} from './ContentExtractionService.js';
export { ExtractUrlTool } from './tools/url.js';
export { ExtractYouTubeTool } from './tools/youtube.js';
export { ExtractWikipediaTool } from './tools/wikipedia.js';
export { ExtractPdfTool } from './tools/pdf.js';
export { ExtractStructuredTool } from './tools/structured.js';
