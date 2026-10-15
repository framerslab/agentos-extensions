/**
 * @file index.ts
 * @description Checks the quoted claims of a document against the pages they cite, with AgentOS's citation tooling and
 * no search service: `parseCitedClaims` finds the claims and their addresses, `checkCitations` reads each page once and
 * grades each claim (word for word first, then through AgentOS's `CitationVerifier` when an embedding function is
 * given), `renderCitationLog` writes the markdown for a "Citation check log" section, and `citationReportFails` decides
 * the result. The pack's one tool is `citation_verify`; the `agentos-citations` command runs the same check.
 *
 * @module @framers/agentos-ext-citation-check
 */

import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';
import { openAIEmbeddings } from './embeddings.js';
import type { EgressProfile } from './page.js';
import { CitationVerifyTool } from './tools/citationVerify.js';
import type { EmbedFn, NliFn } from './types.js';

export * from './types.js';
export { parseCitedClaims, CitationInputError, isHttpUrl, type CitedClaimFormat } from './parse.js';
export { normalizeForMatch, quoteFragments, locateQuote, lexicalNearest, withoutInvisible } from './match.js';
export { pageKey, type EgressProfile, type PageScraper } from './page.js';
export { checkCitations, checkCitationDocument, CitationSetupError, type CitationCheckOptions } from './runner.js';
export { renderCitationLog, citationReportFails, FAILING_VERDICTS, type CitationReportOptions } from './report.js';
export { openAIEmbeddings, managerEmbeddings, type OpenAIEmbeddingOptions, type EmbeddingManagerLike } from './embeddings.js';
export { CitationVerifyTool, type CitationVerifyInput, type CitationVerifyOutput } from './tools/citationVerify.js';
export { runCitationCli, CITATION_CLI_USAGE, type CitationCliIO } from './cli.js';

/** The pack's options, from its manifest entry or from the host's code. */
export interface CitationCheckPackOptions {
  /** `none` (the default) or `openai`: grade a claim not found word for word with OpenAI embeddings through AgentOS. */
  embeddings?: 'none' | 'openai';
  /** The OpenAI embedding model; AgentOS's default when left out. */
  embeddingModel?: string;
  /** The checked egress policy pages are read through: `hosted` (the default) or `local`. Ignored when `fetch` is given. */
  egress?: EgressProfile;
  /** A `fetch` that applies the host's own egress rules, used instead of checked egress. */
  fetch?: typeof globalThis.fetch;
  /** An embedding function of the host's, used instead of `embeddings`. */
  embedFn?: EmbedFn;
  /** An NLI function, such as grounding-guard's `createNliFunction()`, that turns a contradicted `supported` claim. */
  nliFn?: NliFn;
  /** The deadline for each page, in milliseconds; 15,000 when left out. */
  timeoutMs?: number;
  /** The most bytes read of a page; 5,000,000 when left out. */
  maxBytes?: number;
  /** The most distinct pages one call reads; 100 when left out. */
  maxPages?: number;
  /** The tool descriptor's priority; 50 when left out. */
  priority?: number;
}

/**
 * The pack: one tool, `citation_verify`. With `embeddings: 'openai'` the OpenAI key comes from the `openai.apiKey`
 * secret, or `OPENAI_API_KEY` when the secret is not set.
 *
 * @param context - The pack's options, secrets and logger.
 * @throws {TypeError} For an `embeddings` or an `egress` the pack does not know.
 */
export function createExtensionPack(context: ExtensionPackContext = {}): ExtensionPack {
  const options = (context.options ?? {}) as CitationCheckPackOptions;
  const embeddings = options.embeddings ?? 'none';
  if (embeddings !== 'none' && embeddings !== 'openai') throw new TypeError(`embeddings must be none or openai, not ${JSON.stringify(embeddings)}`);
  if (options.egress !== undefined && options.egress !== 'hosted' && options.egress !== 'local') {
    throw new TypeError(`egress must be hosted or local, not ${JSON.stringify(options.egress)}`);
  }
  const apiKey = context.getSecret?.('openai.apiKey');
  const embedFn =
    options.embedFn ??
    (embeddings === 'openai' ? openAIEmbeddings({ ...(apiKey ? { apiKey } : {}), ...(options.embeddingModel ? { model: options.embeddingModel } : {}) }) : undefined);
  const tool = new CitationVerifyTool({
    ...(options.fetch !== undefined ? { fetch: options.fetch } : { egress: options.egress ?? 'hosted' }),
    ...(embedFn !== undefined ? { embedFn } : {}),
    ...(options.nliFn !== undefined ? { nliFn: options.nliFn } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(context.logger !== undefined ? { logger: context.logger } : {}),
  });
  return {
    name: '@framers/agentos-ext-citation-check',
    descriptors: [
      {
        id: tool.name,
        kind: 'tool',
        priority: options.priority ?? 50,
        payload: tool,
        requiredSecrets: [{ id: 'openai.apiKey', optional: true }],
      },
    ],
  };
}

export default createExtensionPack;
