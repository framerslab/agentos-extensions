/**
 * @file citationVerify.ts
 * @description The `citation_verify` tool: an agent passes a document and gets back the report, the markdown log and
 * whether the check fails. Unless the host passes its own `fetch` or another egress policy, the tool reads pages
 * through AgentOS's checked egress with the hosted policy, so a document cannot point it at a private address.
 *
 * @module agentos/extensions/research/citation-check/tools/citationVerify
 */

import type { ITool, JSONSchemaObject, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import type { CitedClaimFormat } from '../parse.js';
import { citationReportFails, renderCitationLog } from '../report.js';
import { checkCitationDocument, type CitationCheckOptions } from '../runner.js';
import type { CitationReport } from '../types.js';

/** The longest document the tool takes, in characters. */
const DOCUMENT_MAX = 1_000_000;

/** What an agent passes the tool. */
export interface CitationVerifyInput {
  /** Markdown whose quoted claims are each followed by their address, or a JSON array of `{ claim, url, exact }`. */
  document: string;
  /** `auto` (the default), `markdown` or `json`. */
  format?: CitedClaimFormat;
  /** Count a claim whose page could not be fetched or read as no failure. */
  allowUnreachable?: boolean;
}

/** What the tool answers. */
export interface CitationVerifyOutput {
  /** Whether the check fails (see `citationReportFails`). */
  fails: boolean;
  /** The markdown for a document's "Citation check log" section. */
  log: string;
  /** The verdicts, the pages and the summary. */
  report: CitationReport;
}

/** Why the arguments cannot be used, or null when they can. */
function argumentProblem(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return 'the arguments must be an object with a document';
  const { document, format, allowUnreachable } = args as Record<string, unknown>;
  if (typeof document !== 'string' || document.trim() === '') return 'document must be a string that is not empty';
  if (document.length > DOCUMENT_MAX) return `document must be at most ${DOCUMENT_MAX} characters`;
  if (format !== undefined && format !== 'auto' && format !== 'markdown' && format !== 'json') return 'format must be auto, markdown or json';
  if (allowUnreachable !== undefined && typeof allowUnreachable !== 'boolean') return 'allowUnreachable must be true or false';
  return null;
}

/** Checks each quoted claim of a document against the page its address names. */
export class CitationVerifyTool implements ITool<CitationVerifyInput, CitationVerifyOutput> {
  /** The tool's identifier, with its version. */
  readonly id = 'citation-verify-v1';
  /** The name an agent calls the tool by. */
  readonly name = 'citation_verify';
  /** The name a person sees. */
  readonly displayName = 'Citation check';
  /** What the tool does, for the model that chooses it. */
  readonly description =
    'Checks each quoted claim in a document against the page its address names: whether its words stand on the page, and, when an embedding model is configured, how closely the page supports it. Each page is fetched once; no search service is called. Pass markdown in which each quotation is followed by its source address, such as "the quoted words" (https://example.org/page), or a JSON array of {"claim", "url", "exact"}.';
  /** The category the tool is listed under. */
  readonly category = 'research';
  /** False: the tool reads pages and changes nothing. */
  readonly hasSideEffects = false;
  /** The arguments: the document, how to read it, and whether a page not read fails the check. */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    required: ['document'],
    properties: {
      document: {
        type: 'string',
        minLength: 1,
        maxLength: DOCUMENT_MAX,
        description: 'Markdown whose quoted claims are each followed by their source address, or a JSON array of {"claim", "url", "exact"}.',
      },
      format: {
        type: 'string',
        enum: ['auto', 'markdown', 'json'],
        default: 'auto',
        description: 'How to read the document: auto reads a JSON array as JSON and anything else as markdown.',
      },
      allowUnreachable: {
        type: 'boolean',
        default: false,
        description: 'Count a claim whose page could not be fetched or read as no failure.',
      },
    },
    additionalProperties: false,
  };

  private readonly options: CitationCheckOptions;

  /**
   * @param options - The check's options. With neither `fetch` nor `egress`, pages are read through AgentOS's checked
   *   egress with the hosted policy (from AgentOS 0.13.120).
   */
  constructor(options: CitationCheckOptions = {}) {
    this.options = options.fetch !== undefined || options.egress !== undefined ? { ...options } : { ...options, egress: 'hosted' };
  }

  /**
   * Checks the document. A document the parser cannot read, arguments of the wrong type and settings the check cannot
   * run with answer `success: false` with the reason; a page that fails is a verdict in the report.
   */
  async execute(args: CitationVerifyInput, context?: ToolExecutionContext): Promise<ToolExecutionResult<CitationVerifyOutput>> {
    const problem = argumentProblem(args);
    if (problem !== null) return { success: false, error: problem };
    // The call's cancellation, when this AgentOS passes one in the context; the options' own otherwise.
    const signal = (context as { signal?: AbortSignal } | undefined)?.signal ?? this.options.signal;
    try {
      const report = await checkCitationDocument(args.document, { ...this.options, ...(signal ? { signal } : {}), format: args.format ?? 'auto' });
      const allowUnreachable = args.allowUnreachable === true;
      return {
        success: true,
        output: { fails: citationReportFails(report, { allowUnreachable }), log: renderCitationLog(report, { allowUnreachable }), report },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
