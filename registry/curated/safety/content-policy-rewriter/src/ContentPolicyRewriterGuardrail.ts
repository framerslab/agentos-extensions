// @ts-nocheck
/**
 * @fileoverview Main guardrail orchestrator for content policy rewriting.
 *
 * Implements IGuardrailService with a two-layer hybrid pipeline:
 * - Layer 1: KeywordPreFilter on streaming text deltas (zero-cost)
 * - Layer 2: LLM Policy Judge + LLM Rewriter on the final response
 *
 * Chunks are read as the AgentOS runtime emits them (`AgentOSResponseChunkType`):
 * a delta is `{ type: 'text_delta', textDelta }`, the final response
 * `{ type: 'final_response', finalResponseText }`. The type is compared without
 * regard to case, and a delta's `text` field is read when `textDelta` is absent.
 *
 * Phase 1 sanitizer — sequential execution, can return SANITIZE with modifiedText.
 *
 * @module content-policy-rewriter/ContentPolicyRewriterGuardrail
 */

import type { ContentPolicyRewriterConfig, PolicyCategory, CategoryConfig, LlmInvoker } from './types.js';
import { resolveCategoryConfig } from './categories.js';
import { ALL_POLICY_CATEGORIES } from './types.js';
import { KeywordPreFilter } from './KeywordPreFilter.js';
import { LlmPolicyJudge } from './LlmPolicyJudge.js';
import { LlmRewriter } from './LlmRewriter.js';

/** GuardrailAction values (avoid import issues by inlining). */
const BLOCK = 'block';
const SANITIZE = 'sanitize';

/** AgentOSResponseChunkType values (avoid import issues by inlining). */
const TEXT_DELTA = 'text_delta';
const FINAL_RESPONSE = 'final_response';

/** The chunk's type in the runtime's lower-case form. */
function chunkTypeOf(chunk: any): string {
  return typeof chunk?.type === 'string' ? chunk.type.toLowerCase() : '';
}

/** A delta's text: `textDelta` as the runtime emits it, else `text`. */
function deltaTextOf(chunk: any): string {
  if (typeof chunk?.textDelta === 'string') return chunk.textDelta;
  if (typeof chunk?.text === 'string') return chunk.text;
  return '';
}

export interface ContentPolicyRewriterOptions extends ContentPolicyRewriterConfig {
  llmInvoker: LlmInvoker;
}

export class ContentPolicyRewriterGuardrail {
  readonly config = {
    canSanitize: true,
    evaluateStreamingChunks: true,
    streamingMode: 'per-chunk' as const,
  };

  private enabledCategories: Partial<Record<PolicyCategory, CategoryConfig>>;
  private keywordFilter: KeywordPreFilter;
  private judge: LlmPolicyJudge;
  private rewriter: LlmRewriter;
  private customRules?: string;

  constructor(options: ContentPolicyRewriterOptions) {
    this.customRules = options.customRules;

    // Resolve enabled categories
    this.enabledCategories = {};
    for (const cat of ALL_POLICY_CATEGORIES) {
      const resolved = resolveCategoryConfig(cat, options.categories);
      if (resolved.enabled) {
        this.enabledCategories[cat] = { enabled: true, action: resolved.action };
      }
    }

    this.keywordFilter = new KeywordPreFilter(options.keywordLists);
    this.judge = new LlmPolicyJudge(options.llmInvoker);
    this.rewriter = new LlmRewriter(options.llmInvoker);

    if (options.streamingPreFilter === false) {
      this.config.evaluateStreamingChunks = false;
    }
  }

  async evaluateInput(_payload: any): Promise<any> {
    return null; // Content policy rewriter only evaluates output
  }

  async evaluateOutput(payload: any): Promise<any> {
    const chunk = payload?.chunk;
    if (!chunk) return null;

    const hasEnabledCategories = Object.keys(this.enabledCategories).length > 0;
    if (!hasEnabledCategories) return null;

    const type = chunkTypeOf(chunk);

    // Layer 1: Keyword pre-filter on streaming chunks
    if (type === TEXT_DELTA) {
      const text = deltaTextOf(chunk);
      if (!text) return null;
      const match = this.keywordFilter.scan(text, this.enabledCategories);
      if (match) {
        const action = this.enabledCategories[match.category]?.action ?? BLOCK;
        return {
          action,
          reasonCode: `KEYWORD_${match.category.toUpperCase()}`,
          ...(action === SANITIZE ? { modifiedText: '[Content removed by policy]' } : {}),
        };
      }
      return null;
    }

    // Layer 2: LLM judge + rewriter on final response
    if (type === FINAL_RESPONSE && typeof chunk.finalResponseText === 'string' && chunk.finalResponseText) {
      const text = chunk.finalResponseText;

      // Quick keyword check — BLOCK immediately if keyword match + action=block
      const kwMatch = this.keywordFilter.scan(text, this.enabledCategories);
      if (kwMatch && this.enabledCategories[kwMatch.category]?.action === BLOCK) {
        return {
          action: BLOCK,
          reasonCode: `KEYWORD_${kwMatch.category.toUpperCase()}`,
        };
      }

      // LLM classification
      const judgeResult = await this.judge.classify(text, this.enabledCategories, this.customRules);
      if (judgeResult.violations.length === 0) return null;

      // Check if all violations map to BLOCK
      const allBlock = judgeResult.violations.every(
        v => this.enabledCategories[v.category]?.action === BLOCK,
      );
      if (allBlock) {
        return {
          action: BLOCK,
          reasonCode: judgeResult.violations.map(v => v.category).join(','),
        };
      }

      // At least one SANITIZE — rewrite
      const rewritten = await this.rewriter.rewrite(text, judgeResult.violations, this.customRules);
      return {
        action: SANITIZE,
        modifiedText: rewritten,
        reasonCode: judgeResult.violations.map(v => v.category).join(','),
      };
    }

    return null;
  }
}
