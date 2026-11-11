// @ts-nocheck
/**
 * @file types.ts
 * @description Core type definitions for the Topicality guardrail extension pack.
 *
 * Defines the configuration interface that controls which topics are allowed
 * or blocked, similarity thresholds, and optional LLM fallback for ambiguous
 * cases.
 *
 * @module agentos/extensions/packs/topicality/types
 */

// ---------------------------------------------------------------------------
// TopicalityOptions
// ---------------------------------------------------------------------------

/**
 * Configuration object passed to `createTopicalityGuardrail()`.
 *
 * Controls the list of allowed and blocked topics, similarity thresholds for
 * embedding-based matching, and an optional LLM invoker for fallback
 * classification when embeddings are unavailable or inconclusive.
 *
 * @example
 * ```typescript
 * const opts: TopicalityOptions = {
 *   allowedTopics: ['customer support', 'billing', 'product features'],
 *   blockedTopics: ['politics', 'violence', 'gambling'],
 *   minSimilarity: 0.35,
 *   maxBlockedSimilarity: 0.55,
 * };
 * ```
 */
export interface TopicalityOptions {
  /**
   * Topics that the agent is permitted to discuss.
   *
   * Each entry is a short natural-language description (e.g. "customer support",
   * "product pricing").  The guardrail computes cosine similarity between the
   * user input embedding and each allowed topic embedding.  If no allowed topic
   * exceeds {@link minSimilarity}, the input is flagged as off-topic.
   *
   * An empty array, or none, means "no topic restriction" (all inputs are
   * on-topic by default unless they match a blocked topic). With no allowed
   * and no blocked topic the guardrail passes every input and logs one line
   * saying so.
   */
  allowedTopics?: string[];

  /**
   * Topics that the agent must refuse to discuss.
   *
   * Each entry is a short natural-language description (e.g. "politics",
   * "violence").  If the cosine similarity between the user input and any
   * blocked topic exceeds {@link maxBlockedSimilarity}, the input is blocked
   * outright.
   *
   * Blocked-topic checks run before allowed-topic checks, so a message that
   * matches both a blocked and an allowed topic will be blocked.
   *
   * An empty array, or none, blocks nothing.
   */
  blockedTopics?: string[];

  /**
   * Minimum cosine similarity (inclusive) between the input embedding and the
   * best-matching allowed topic for the input to be considered on-topic.
   *
   * Values closer to 0 are more permissive; values closer to 1 are stricter.
   * Must be in the range [0, 1].
   *
   * @default 0.3
   */
  minSimilarity?: number;

  /**
   * Maximum cosine similarity (inclusive) between the input embedding and any
   * blocked topic before the input is blocked outright.
   *
   * Values closer to 0 are stricter (blocks more); values closer to 1 are
   * more permissive (blocks less).  Must be in the range [0, 1].
   *
   * @default 0.5
   */
  maxBlockedSimilarity?: number;

  /**
   * Optional LLM callable used as a fallback when local embeddings are
   * unavailable (e.g. `@huggingface/transformers` not installed) or when
   * the embedding similarity scores are ambiguous (near the threshold).
   *
   * The function receives a fully-formed classification prompt and must
   * return the raw LLM response text, which the guardrail parses as JSON.
   *
   * @param prompt - The classification prompt to send to the LLM.
   * @returns A promise resolving to the raw LLM response text.
   */
  llmInvoker?: (prompt: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// TopicalityLogger
// ---------------------------------------------------------------------------

/**
 * Where the guardrail writes its one line about running with no topics, and
 * its one line when the embedding tier cannot load: the host's logger (an
 * AgentOS `ILogger` fits), else the console.
 */
export interface TopicalityLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// TopicMatchResult
// ---------------------------------------------------------------------------

/**
 * Result of a single topic-matching evaluation.
 *
 * Returned by {@link CheckTopicTool} and used internally by the guardrail
 * to communicate classification outcomes.
 */
export interface TopicMatchResult {
  /** Whether the input text is considered on-topic. */
  onTopic: boolean;

  /**
   * Confidence score in the range [0, 1].
   *
   * For embedding-based evaluation this is the cosine similarity to the
   * best-matching allowed topic.  For LLM-based evaluation this is the
   * confidence value returned by the LLM.  For keyword matching this is
   * a fixed heuristic value.
   */
  confidence: number;

  /**
   * The detected topic string that best matches the input.
   *
   * May be one of the allowed topics, one of the blocked topics, or
   * `'unknown'` when no topic could be identified.
   */
  detectedTopic: string;
}

// ---------------------------------------------------------------------------
// Service identity constants
// ---------------------------------------------------------------------------

/**
 * Stable string identifiers for services provided by the topicality pack.
 *
 * Values follow the AgentOS convention: `agentos:<domain>:<service-name>`.
 */
export const TOPICALITY_SERVICE_IDS = {
  /**
   * The feature-extraction pipeline instance used to compute text embeddings
   * for cosine-similarity topic matching.
   */
  EMBEDDING_PIPELINE: 'agentos:topicality:embedding-pipeline',
} as const;

/**
 * Union of all {@link TOPICALITY_SERVICE_IDS} values.
 */
export type TopicalityServiceId =
  (typeof TOPICALITY_SERVICE_IDS)[keyof typeof TOPICALITY_SERVICE_IDS];
