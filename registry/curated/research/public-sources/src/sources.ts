/**
 * @file sources.ts
 * @description A fetched article as passages: each sentence the caller's cut finds in each block, shaped as AgentOS's
 * `VerificationSource` with the article's attribution and the sentence's place.
 *
 * @module agentos/extensions/research/public-sources/sources
 */

import type { CitationSource, SourceDocument } from './types.js';

/** Every sentence of the document's blocks, in order, as a passage; `cut` answers a block's sentences as offsets. */
export function citationSources(document: SourceDocument, cut: (text: string) => Array<{ start: number; end: number }>): CitationSource[] {
  const out: CitationSource[] = [];
  document.blocks.forEach((text, block) => {
    for (const { start, end } of cut(text)) {
      out.push({
        content: text.slice(start, end),
        title: document.title,
        url: document.url,
        site: document.site,
        key: document.key,
        revision: document.revision,
        readAt: document.readAt,
        licence: document.licence,
        block,
        start,
        end,
      });
    }
  });
  return out;
}
