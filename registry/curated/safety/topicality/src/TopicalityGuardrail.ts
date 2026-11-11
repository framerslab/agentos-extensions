// @ts-nocheck
/**
 * @file TopicalityGuardrail.ts
 * @description Guardrail service that enforces on/off-topic boundaries for
 * agent conversations using a three-tier evaluation strategy:
 *
 * 1. **Embedding similarity** (primary) — cosine similarity between input
 *    and topic embeddings via `@huggingface/transformers`.
 * 2. **LLM-as-judge** (fallback) — structured JSON classification prompt
 *    sent to the configured LLM invoker.
 * 3. **Keyword matching** (last resort) — simple substring search against
 *    topic strings when neither embeddings nor LLM are available.
 *
 * The guardrail only evaluates input (user messages).  Output evaluation
 * returns `null` (pass-through) because topic drift in agent responses is
 * best handled at the input gate.
 *
 * ### Guardrail pipeline phase
 *
 * This guardrail sets `canSanitize: false` and `evaluateStreamingChunks: false`,
 * placing it in Phase 2 (parallel) of the guardrail dispatcher.  It never
 * modifies content — it only FLAGs or BLOCKs.
 *
 * @module agentos/extensions/packs/topicality/TopicalityGuardrail
 */

import type {
  IGuardrailService,
  GuardrailConfig,
  GuardrailInputPayload,
  GuardrailOutputPayload,
  GuardrailEvaluationResult,
} from '@framers/agentos';
import { GuardrailAction } from '@framers/agentos';

import type { TopicalityLogger, TopicalityOptions, TopicMatchResult } from './types.js';
import { cosineSimilarity, topicEmbeddingCache, clearEmbeddingCache } from './embeddings.js';

// ---------------------------------------------------------------------------
// Embedding helper — lazy-loaded from optional @huggingface/transformers
// ---------------------------------------------------------------------------

/** Cached pipeline function (or null if the package is unavailable). */
let _pipelineFn: ((task: string, model?: string) => Promise<unknown>) | null | undefined;

/** What the import or the model load threw, kept for each guardrail's warning. */
let _loadError: unknown;

/** Cached extractor instance. */
let _extractor: {
  (
    texts: string[],
    opts: { pooling: string; normalize: boolean }
  ): Promise<{ tolist: () => number[][] }>;
} | null = null;

/**
 * Attempt to load the feature-extraction pipeline from `@huggingface/transformers`.
 * Returns `null` if the package is not installed.
 */
async function getExtractor(): Promise<typeof _extractor> {
  if (_extractor) return _extractor;
  if (_pipelineFn === null) return null; // already tried and failed

  try {
    // Dynamic import — package is an optionalDependency
    const hf = await import('@huggingface/transformers');
    _pipelineFn = hf.pipeline as typeof _pipelineFn;
    _extractor = (await _pipelineFn!(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    )) as typeof _extractor;
    return _extractor;
  } catch (error) {
    _pipelineFn = null;
    _loadError = error;
    return null;
  }
}

/**
 * Embed a single text string, returning a numeric vector.
 * Uses the cached extractor pipeline or returns `null` if unavailable.
 */
async function embed(text: string): Promise<number[] | null> {
  const extractor = await getExtractor();
  if (!extractor) return null;

  // Check cache first
  const cached = topicEmbeddingCache.get(text);
  if (cached) return cached;

  const output = await extractor([text], { pooling: 'mean', normalize: true });
  const vec = output.tolist()[0];
  topicEmbeddingCache.set(text, vec);
  return vec;
}

// ---------------------------------------------------------------------------
// TopicalityGuardrail
// ---------------------------------------------------------------------------

/**
 * Guardrail that enforces topic boundaries on user input.
 *
 * Implements {@link IGuardrailService} with input-only evaluation.
 * Runs in Phase 2 (parallel, non-sanitizing) of the guardrail dispatcher.
 */
export class TopicalityGuardrail implements IGuardrailService {
  /**
   * Guardrail configuration — Phase 2 parallel (no sanitization, no streaming).
   */
  readonly config: GuardrailConfig = {
    canSanitize: false,
    evaluateStreamingChunks: false,
  };

  /** Resolved options with defaults applied. */
  private readonly opts: Required<
    Pick<
      TopicalityOptions,
      'minSimilarity' | 'maxBlockedSimilarity' | 'allowedTopics' | 'blockedTopics'
    >
  > &
    Pick<TopicalityOptions, 'llmInvoker'>;

  /** The host's logger, for the lines about no topics and an unavailable embedding tier. */
  private readonly logger: TopicalityLogger | undefined;

  /** Whether that line has been written. */
  private noTopicsLogged = false;

  /** Whether the line about an unavailable embedding tier has been written. */
  private embeddingsUnavailableLogged = false;

  /**
   * @param options - Topicality configuration provided by the pack factory.
   *   Left out, or with neither list, the guardrail passes every input.
   * @param logger - The host's logger; the console when left out.
   */
  constructor(options?: Partial<TopicalityOptions> | null, logger?: TopicalityLogger) {
    const given: Partial<TopicalityOptions> = options ?? {};
    this.opts = {
      allowedTopics: topicList(given.allowedTopics),
      blockedTopics: topicList(given.blockedTopics),
      minSimilarity: given.minSimilarity ?? 0.3,
      maxBlockedSimilarity: given.maxBlockedSimilarity ?? 0.5,
      llmInvoker: given.llmInvoker,
    };
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // IGuardrailService — input evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate user input for topic relevance.
   *
   * Runs the three-tier evaluation strategy:
   * 1. Embedding similarity (if `@huggingface/transformers` available)
   * 2. LLM-as-judge (if `llmInvoker` configured)
   * 3. Keyword matching (always available)
   *
   * @param payload - The input payload containing user text and context.
   * @returns A guardrail result (FLAG/BLOCK) or `null` to allow.
   */
  async evaluateInput(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    // No topic either way: nothing to enforce, so every input passes, and the first says why.
    if (this.opts.allowedTopics.length === 0 && this.opts.blockedTopics.length === 0) {
      this.logNoTopics();
      return null;
    }

    const text = payload.input.textInput;
    if (!text || text.trim().length === 0) return null;

    // Try the three methods in order
    const result =
      (await this.evaluateViaEmbeddings(text)) ??
      (await this.evaluateViaLlm(text)) ??
      this.evaluateViaKeywords(text);

    if (!result) return null;

    return this.toGuardrailResult(result);
  }

  // -------------------------------------------------------------------------
  // IGuardrailService — output evaluation (pass-through)
  // -------------------------------------------------------------------------

  /**
   * Output evaluation — returns `null` (pass-through).
   *
   * Topic enforcement is applied at the input gate only.  Agent responses
   * are not evaluated for topicality.
   */
  async evaluateOutput(
    _payload: GuardrailOutputPayload
  ): Promise<GuardrailEvaluationResult | null> {
    return null;
  }

  // -------------------------------------------------------------------------
  // Method 1: Embedding-based evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate input via cosine similarity between embeddings.
   *
   * Embeds the input text and each topic string, then compares similarities
   * against the configured thresholds.
   *
   * @param text - The user input text.
   * @returns A {@link TopicMatchResult} or `null` if embeddings are unavailable.
   */
  private async evaluateViaEmbeddings(text: string): Promise<TopicMatchResult | null> {
    const inputVec = await embed(text);
    if (!inputVec) {
      this.logEmbeddingsUnavailable();
      return null;
    }

    // --- Check blocked topics first ---
    for (const blockedTopic of this.opts.blockedTopics) {
      const topicVec = await embed(blockedTopic);
      if (!topicVec) continue;

      const sim = cosineSimilarity(inputVec, topicVec);
      if (sim >= this.opts.maxBlockedSimilarity) {
        return { onTopic: false, confidence: sim, detectedTopic: blockedTopic };
      }
    }

    // --- Check allowed topics ---
    if (this.opts.allowedTopics.length === 0) {
      // No allowed topics configured — everything not blocked is on-topic
      return { onTopic: true, confidence: 1.0, detectedTopic: 'unfiltered' };
    }

    let bestSim = -Infinity;
    let bestTopic = 'unknown';

    for (const allowedTopic of this.opts.allowedTopics) {
      const topicVec = await embed(allowedTopic);
      if (!topicVec) continue;

      const sim = cosineSimilarity(inputVec, topicVec);
      if (sim > bestSim) {
        bestSim = sim;
        bestTopic = allowedTopic;
      }
    }

    if (bestSim >= this.opts.minSimilarity) {
      return { onTopic: true, confidence: bestSim, detectedTopic: bestTopic };
    }

    // Below threshold — off-topic
    return { onTopic: false, confidence: bestSim, detectedTopic: bestTopic };
  }

  // -------------------------------------------------------------------------
  // Method 2: LLM-as-judge evaluation
  // -------------------------------------------------------------------------

  /**
   * Evaluate input via LLM classification prompt.
   *
   * Sends a structured prompt to the configured LLM invoker asking it to
   * classify the input as on-topic or off-topic and return JSON.
   *
   * @param text - The user input text.
   * @returns A {@link TopicMatchResult} or `null` if no LLM invoker is configured.
   */
  private async evaluateViaLlm(text: string): Promise<TopicMatchResult | null> {
    if (!this.opts.llmInvoker) return null;

    const allowedStr =
      this.opts.allowedTopics.length > 0 ? this.opts.allowedTopics.join(', ') : '(any topic)';
    const blockedStr =
      this.opts.blockedTopics.length > 0 ? this.opts.blockedTopics.join(', ') : '(none)';

    const prompt = [
      'You are a topic classification judge.',
      `Allowed topics: ${allowedStr}`,
      `Blocked topics: ${blockedStr}`,
      '',
      `User message: "${text}"`,
      '',
      'Is this message about one of the allowed topics and NOT about a blocked topic?',
      'Return ONLY valid JSON (no markdown, no explanation):',
      '{ "onTopic": <boolean>, "confidence": <float 0-1>, "detectedTopic": "<string>" }',
    ].join('\n');

    try {
      const raw = await this.opts.llmInvoker(prompt);
      // Extract JSON from the response (handle possible markdown fences)
      const jsonMatch = raw.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as TopicMatchResult;
      return {
        onTopic: Boolean(parsed.onTopic),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        detectedTopic: typeof parsed.detectedTopic === 'string' ? parsed.detectedTopic : 'unknown',
      };
    } catch {
      // LLM failed — fall through to keyword matching
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Method 3: Keyword matching (last resort)
  // -------------------------------------------------------------------------

  /**
   * Evaluate input via simple case-insensitive substring matching against
   * topic strings.
   *
   * This is the fallback of last resort when neither embeddings nor LLM
   * are available.  It checks whether any topic string appears as a
   * substring of the input (or vice versa).
   *
   * @param text - The user input text.
   * @returns A {@link TopicMatchResult}.
   */
  private evaluateViaKeywords(text: string): TopicMatchResult {
    const lower = text.toLowerCase();

    // --- Check blocked topics first ---
    for (const blockedTopic of this.opts.blockedTopics) {
      const topicLower = blockedTopic.toLowerCase();
      if (lower.includes(topicLower) || topicLower.includes(lower)) {
        return { onTopic: false, confidence: 0.8, detectedTopic: blockedTopic };
      }
    }

    // --- Check allowed topics ---
    if (this.opts.allowedTopics.length === 0) {
      return { onTopic: true, confidence: 0.5, detectedTopic: 'unfiltered' };
    }

    for (const allowedTopic of this.opts.allowedTopics) {
      const topicLower = allowedTopic.toLowerCase();
      if (lower.includes(topicLower) || topicLower.includes(lower)) {
        return { onTopic: true, confidence: 0.7, detectedTopic: allowedTopic };
      }
    }

    // No keyword match — off-topic
    return { onTopic: false, confidence: 0.5, detectedTopic: 'unknown' };
  }

  // -------------------------------------------------------------------------
  // Result mapping
  // -------------------------------------------------------------------------

  /**
   * Convert a {@link TopicMatchResult} into a {@link GuardrailEvaluationResult}.
   *
   * - On-topic results return `null` (allow).
   * - Blocked-topic matches return `BLOCK`.
   * - Off-topic (below allowed threshold) returns `FLAG`.
   *
   * @param result - The topic match result to convert.
   * @returns A guardrail evaluation result, or `null` to allow.
   */
  private toGuardrailResult(result: TopicMatchResult): GuardrailEvaluationResult | null {
    if (result.onTopic) return null;

    // Determine if this is a blocked-topic hit or just off-topic
    const isBlockedHit = this.opts.blockedTopics.some(
      (t) => t.toLowerCase() === result.detectedTopic.toLowerCase()
    );

    const action = isBlockedHit ? GuardrailAction.BLOCK : GuardrailAction.FLAG;
    const reason = isBlockedHit
      ? `Message matches blocked topic: "${result.detectedTopic}"`
      : `Message is off-topic (best match: "${result.detectedTopic}", confidence: ${result.confidence.toFixed(2)})`;

    return {
      action,
      reason,
      reasonCode: isBlockedHit ? 'BLOCKED_TOPIC' : 'OFF_TOPIC',
      metadata: {
        detectedTopic: result.detectedTopic,
        confidence: result.confidence,
        onTopic: result.onTopic,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Clear cached embeddings.  Called during pack deactivation.
   */
  clearCache(): void {
    clearEmbeddingCache();
  }

  /**
   * Writes, once for this guardrail, that the embedding tier is unavailable,
   * why, and which tier decides instead.
   */
  private logEmbeddingsUnavailable(): void {
    if (this.embeddingsUnavailableLogged) return;
    this.embeddingsUnavailableLogged = true;
    const reason = _loadError instanceof Error ? _loadError.message : String(_loadError);
    const next = this.opts.llmInvoker
      ? 'the LLM tier (llmInvoker), then the keyword tier'
      : 'the keyword tier';
    const line = `topicality: the embedding tier is unavailable (Xenova/all-MiniLM-L6-v2 could not load: ${reason}); deciding with ${next}`;
    if (this.logger) this.logger.warn(line);
    else console.warn(line);
  }

  /**
   * Writes, once for this guardrail, why it passes every input: it was given
   * no allowed and no blocked topic.
   */
  private logNoTopics(): void {
    if (this.noTopicsLogged) return;
    this.noTopicsLogged = true;
    const line =
      'topicality: no allowedTopics or blockedTopics configured, so this guardrail passes every input';
    if (this.logger) this.logger.warn(line);
    else console.warn(line);
  }
}

/**
 * A topic list as the options give it: the strings of an array, else none.
 * A host that names no topics (a manifest entry with no options, the
 * registry's options) gives `undefined` here.
 */
function topicList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((topic): topic is string => typeof topic === 'string') : [];
}
