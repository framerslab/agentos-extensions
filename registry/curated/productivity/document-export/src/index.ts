// @ts-nocheck
/**
 * @module index
 *
 * Document Export Extension Pack — generates PDF, DOCX, PPTX, CSV, and
 * XLSX documents from structured content provided by agents.
 *
 * Entry point for the extension; follows the standard AgentOS extension
 * pack factory pattern (see {@link createExtensionPack}). The factory
 * wires up all five format generators, the {@link ExportFileManager} for
 * file persistence, and registers both the `document_export` and
 * `document_suggest` tools.
 */

import { CsvGenerator } from './generators/CsvGenerator.js';
import { XlsxGenerator } from './generators/XlsxGenerator.js';
import { PdfGenerator } from './generators/PdfGenerator.js';
import { DocxGenerator } from './generators/DocxGenerator.js';
import { SlidesGenerator } from './generators/SlidesGenerator.js';
import { ExportFileManager } from './delivery/ExportFileManager.js';
import { DocumentExportTool } from './tools/documentExport.js';
import { DocumentSuggestTool } from './tools/documentSuggest.js';

/**
 * Options accepted by the Document Export extension pack factory.
 */
export interface DocumentExportExtensionOptions {
  /** Override the default priority used when registering the tools. */
  priority?: number;

  /** Override the agent workspace directory (defaults to `process.cwd()`). */
  workspaceDir?: string;

  /** Override the server port used for download/preview URLs (defaults to `3777`). */
  serverPort?: number;

  /** Override the externally reachable base URL used in export links. */
  publicBaseUrl?: string;
}

/**
 * Factory function called by the AgentOS extension loader. Returns a pack
 * descriptor containing the `document_export` and `document_suggest` tools.
 *
 * The factory:
 *
 * 1. Resolves the workspace directory and server port from context options.
 * 2. Creates the {@link ExportFileManager} for file I/O.
 * 3. Instantiates all five format generators (CSV, XLSX, PDF, DOCX, PPTX).
 * 4. Wires the generators and file manager into the {@link DocumentExportTool}.
 * 5. Creates the stateless {@link DocumentSuggestTool}.
 * 6. Returns both tools as extension pack descriptors with lifecycle hooks.
 *
 * @param context - Extension activation context provided by the AgentOS runtime.
 * @returns An extension pack with tool descriptors and lifecycle hooks.
 */
export function createExtensionPack(context: any) {
  const options = (context.options || {}) as DocumentExportExtensionOptions;

  // Resolve configuration
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const serverPort = options.serverPort ?? 3777;
  const priority = options.priority ?? 50;
  const publicBaseUrl = options.publicBaseUrl;

  // Create the file manager
  const fileManager = new ExportFileManager(workspaceDir, serverPort, publicBaseUrl);

  // Create all format generators
  const csvGenerator = new CsvGenerator();
  const xlsxGenerator = new XlsxGenerator();
  const pdfGenerator = new PdfGenerator();
  const docxGenerator = new DocxGenerator();
  const slidesGenerator = new SlidesGenerator();

  // Create tools with all dependencies injected
  const exportTool = new DocumentExportTool(
    csvGenerator,
    xlsxGenerator,
    pdfGenerator,
    docxGenerator,
    slidesGenerator,
    fileManager,
  );

  const suggestTool = new DocumentSuggestTool();

  return {
    name: '@framers/agentos-ext-document-export',
    version: '0.1.0',
    descriptors: [
      {
        id: exportTool.name,
        kind: 'tool' as const,
        priority,
        payload: exportTool,
      },
      {
        id: suggestTool.name,
        kind: 'tool' as const,
        priority,
        payload: suggestTool,
      },
    ],
    onActivate: async () =>
      context.logger?.info(
        'Document Export activated \u2014 PDF, DOCX, PPTX, CSV, XLSX',
      ),
    onDeactivate: async () =>
      context.logger?.info('Document Export Extension deactivated'),
  };
}

export default createExtensionPack;

// Re-export tools for direct consumption
export { DocumentExportTool } from './tools/documentExport.js';
export { DocumentSuggestTool } from './tools/documentSuggest.js';
export { ExportFileManager } from './delivery/ExportFileManager.js';
export { PreviewGenerator } from './preview/PreviewGenerator.js';

// Browser-safe helpers, also served by the `./calendar` and `./transcript` entries.
export { icsEvent, googleCalendarAddress } from './calendar/index.js';
export type { IcsEventInput, GoogleCalendarEventInput, CalendarEventTimes } from './calendar/index.js';
export { markdownText } from './text/markdown.js';

// Re-export all public types so consumers can `import { ... } from '@framers/agentos-ext-document-export'`.
export type {
  ExportFormat,
  SlideTheme,
  ChartDataSet,
  ChartSpec,
  ImageSpec,
  TableData,
  DocumentSection,
  DocumentContent,
  ExportOptions,
  DocumentExportInput,
  DocumentExportOutput,
  DocumentSuggestInput,
  DocumentSuggestOutput,
} from './types.js';
