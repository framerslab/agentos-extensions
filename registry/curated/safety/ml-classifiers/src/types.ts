// @ts-nocheck
/**
 * @file types.ts
 * @description Core type definitions for the ML Classifiers extension pack.
 *
 * Defines the shared interfaces used across the ML classification system:
 * classifier categories, confidence results, option shapes, and the LLM
 * invoker callback signature.
 *
 * @module ml-classifiers/types
 */

// ---------------------------------------------------------------------------
// Category type
// ---------------------------------------------------------------------------

/**
 * Safety categories evaluated by the ML classifier.
 *
 * - `'toxic'`     — Hateful, abusive, or threatening language.
 * - `'injection'` — Prompt injection or jailbreak attempts.
 * - `'nsfw'`      — Sexually explicit or adult content.
 * - `'threat'`    — Direct threats of violence or self-harm.
 */
export type ClassifierCategory = 'toxic' | 'injection' | 'nsfw' | 'threat';

/**
 * All supported classifier categories as a constant array, used for
 * iteration and default configuration.
 */
export const ALL_CATEGORIES: ClassifierCategory[] = ['toxic', 'injection', 'nsfw', 'threat'];

// ---------------------------------------------------------------------------
// Result interfaces
// ---------------------------------------------------------------------------

/**
 * Confidence score for a single safety category.
 *
 * Scores are normalised to the range `[0, 1]`, where `0` means "no signal"
 * and `1` means "extremely confident match".
 */
export interface CategoryScore {
  /** The safety category this score applies to. */
  name: ClassifierCategory;

  /** Normalised confidence score in the range [0, 1]. */
  confidence: number;
}

/**
 * Complete result from a classification pass over a text input.
 *
 * Includes per-category scores and an overall `flagged` boolean that is
 * `true` when any category exceeds the configured flag threshold (default 0.5).
 */
export interface ClassifierResult {
  /**
   * Per-category confidence scores, one entry for each category that was
   * evaluated.
   */
  categories: CategoryScore[];

  /**
   * `true` when at least one category score exceeds the flag threshold.
   * Convenience field — equivalent to `categories.some(c => c.confidence > flagThreshold)`.
   */
  flagged: boolean;

  /**
   * Which classification backend produced this result.
   * Useful for logging and debugging which tier was active.
   */
  source: 'onnx' | 'llm' | 'keyword';
}

// ---------------------------------------------------------------------------
// LLM invoker callback
// ---------------------------------------------------------------------------

/**
 * Callback signature for invoking an LLM to perform classification when
 * ONNX models are unavailable.
 *
 * The callback receives a system prompt and a user message and returns
 * the raw LLM text response.  The caller is responsible for parsing the
 * JSON output.
 *
 * @param systemPrompt - Instruction prompt describing the classification task.
 * @param userMessage  - The text to classify.
 * @returns The raw string response from the LLM.
 */
export type LlmInvoker = (systemPrompt: string, userMessage: string) => Promise<string>;

// ---------------------------------------------------------------------------
// Pack options
// ---------------------------------------------------------------------------

/**
 * Configuration options for the ML Classifiers extension pack.
 *
 * All properties are optional.  Sensible defaults allow zero-config operation
 * using the keyword fallback classifier.
 */
export interface MLClassifierOptions {
  /**
   * Which safety categories to evaluate.
   * @default ALL_CATEGORIES
   */
  categories?: ClassifierCategory[];

  /**
   * Per-category confidence thresholds that override the global defaults.
   *
   * Keys are category names; values are threshold overrides with optional
   * `flag` and `block` levels.
   *
   * @example `{ toxic: { flag: 0.4, block: 0.7 } }`
   */
  thresholds?: Partial<Record<ClassifierCategory, { flag?: number; block?: number }>>;

  /**
   * Global flag threshold applied to all categories that do not have a
   * per-category override.
   * @default 0.5
   */
  flagThreshold?: number;

  /**
   * Global block threshold applied to all categories that do not have a
   * per-category override.
   * @default 0.8
   */
  blockThreshold?: number;

  /**
   * Optional LLM invoker callback.  When provided and ONNX models are
   * unavailable, the classifier will fall back to LLM-as-judge classification
   * using this callback.
   *
   * When omitted AND ONNX models are unavailable, the classifier falls back
   * to keyword-based detection.
   */
  llmInvoker?: LlmInvoker;
}

// ---------------------------------------------------------------------------
// MLClassifierLogger
// ---------------------------------------------------------------------------

/**
 * Where the guardrail writes its one line when the ONNX tier cannot load: the
 * host's logger (an AgentOS `ILogger` fits), else the console.
 */
export interface MLClassifierLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}
