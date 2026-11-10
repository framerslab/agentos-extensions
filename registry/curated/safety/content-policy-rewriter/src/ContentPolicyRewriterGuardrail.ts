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

/** How much of a stream's earlier text is kept to find a phrase split across deltas. */
const CARRY_CHARS = 128;

/** Streams whose earlier text is kept at once; the oldest is dropped past this. */
const MAX_TRACKED_STREAMS = 1024;

/** The stream a chunk belongs to. */
function streamKeyOf(chunk: any): string {
  return typeof chunk?.streamId === 'string' ? chunk.streamId : '';
}

/** The violations' categories, each once, comma-separated. */
function uniqueCategories(violations: { category: string }[]): string {
  return [...new Set(violations.map(v => v.category))].join(',');
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
  /** The enabled categories, those whose action is block first, so a block match wins over a sanitize one. */
  private orderedCategories: Partial<Record<PolicyCategory, CategoryConfig>>;
  private blockCategories: Partial<Record<PolicyCategory, CategoryConfig>>;
  private keywordFilter: KeywordPreFilter;
  private judge: LlmPolicyJudge;
  private rewriter: LlmRewriter;
  private customRules?: string;
  private judgeFailure: 'block' | 'allow';
  /** Per stream, the tail of the text already scanned, so a phrase split across deltas is found. */
  private carries = new Map<string, string>();

  constructor(options: ContentPolicyRewriterOptions) {
    this.customRules = options.customRules;
    this.judgeFailure = options.judgeFailure === 'allow' ? 'allow' : 'block';

    // Resolve enabled categories
    this.enabledCategories = {};
    for (const cat of ALL_POLICY_CATEGORIES) {
      const resolved = resolveCategoryConfig(cat, options.categories);
      if (resolved.enabled) {
        this.enabledCategories[cat] = { enabled: true, action: resolved.action };
      }
    }
    this.blockCategories = {};
    const sanitizeCategories: Partial<Record<PolicyCategory, CategoryConfig>> = {};
    for (const [cat, cfg] of Object.entries(this.enabledCategories)) {
      if (cfg.action === SANITIZE) sanitizeCategories[cat as PolicyCategory] = cfg;
      else this.blockCategories[cat as PolicyCategory] = cfg;
    }
    this.orderedCategories = { ...this.blockCategories, ...sanitizeCategories };

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
      if (!this.config.evaluateStreamingChunks) return null;
      const text = deltaTextOf(chunk);
      if (!text) return null;

      // The tail of this stream's earlier deltas goes in front, so a phrase split across two deltas is found;
      // only a match reaching into this delta counts, since the tail was judged with the delta it came in.
      const key = streamKeyOf(chunk);
      const carry = this.carries.get(key) ?? '';
      const scanned = carry + text;
      const match = this.keywordFilter.scanAfter(scanned, this.orderedCategories, carry.length);
      if (match) {
        this.carries.delete(key);
        const action = this.enabledCategories[match.category]?.action ?? BLOCK;
        return {
          action,
          reasonCode: `KEYWORD_${match.category.toUpperCase()}`,
          ...(action === SANITIZE ? { modifiedText: '[Content removed by policy]' } : {}),
        };
      }
      this.rememberCarry(key, scanned);
      return null;
    }

    // Layer 2: LLM judge + rewriter on final response
    if (type === FINAL_RESPONSE) {
      this.carries.delete(streamKeyOf(chunk));
      if (typeof chunk.finalResponseText !== 'string' || !chunk.finalResponseText) return null;
      const text = chunk.finalResponseText;

      // Quick keyword check: a match in any block category blocks at once, before any LLM call
      const kwMatch = this.keywordFilter.scan(text, this.blockCategories);
      if (kwMatch) {
        return {
          action: BLOCK,
          reasonCode: `KEYWORD_${kwMatch.category.toUpperCase()}`,
        };
      }

      // LLM classification; the judge keeps only violations of the enabled categories
      const judgeResult = await this.judge.classify(text, this.enabledCategories, this.customRules);
      if (judgeResult.failed) {
        return this.judgeFailure === 'allow' ? null : { action: BLOCK, reasonCode: 'JUDGE_FAILED' };
      }
      if (judgeResult.violations.length === 0) return null;

      // Any violation in a block category blocks the reply
      const blocking = judgeResult.violations.filter(v => this.enabledCategories[v.category]?.action !== SANITIZE);
      if (blocking.length > 0) {
        return {
          action: BLOCK,
          reasonCode: uniqueCategories(blocking),
        };
      }

      // Every violation is sanitizable: rewrite, and block when no rewrite comes back
      const rewritten = await this.rewriter.tryRewrite(text, judgeResult.violations, this.customRules);
      if (rewritten === null) {
        return { action: BLOCK, reasonCode: 'REWRITE_FAILED' };
      }
      return {
        action: SANITIZE,
        modifiedText: rewritten,
        reasonCode: uniqueCategories(judgeResult.violations),
      };
    }

    return null;
  }

  /** Keep the last words of what was scanned for the stream's next delta, cut at a space so no word is split. */
  private rememberCarry(key: string, scanned: string): void {
    let tail = scanned.length > CARRY_CHARS ? scanned.slice(-CARRY_CHARS) : scanned;
    if (scanned.length > CARRY_CHARS) {
      const space = tail.search(/\s/);
      tail = space === -1 ? '' : tail.slice(space);
    }
    this.carries.delete(key);
    this.carries.set(key, tail);
    if (this.carries.size > MAX_TRACKED_STREAMS) {
      const oldest = this.carries.keys().next().value;
      if (oldest !== undefined) this.carries.delete(oldest);
    }
  }
}
