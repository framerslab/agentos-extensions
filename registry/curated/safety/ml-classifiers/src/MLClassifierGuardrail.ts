// @ts-nocheck
/**
 * @file MLClassifierGuardrail.ts
 * @description IGuardrailService implementation that classifies text for toxicity,
 * prompt injection, NSFW content, and threats using a three-tier strategy:
 *
 * 1. **ONNX inference** — attempts to load `@huggingface/transformers` at runtime
 *    and run a lightweight ONNX classification model.
 * 2. **LLM-as-judge** — falls back to an LLM invoker callback that prompts a
 *    language model for structured JSON safety classification.
 * 3. **Keyword matching** — last-resort regex/keyword-based detection when neither
 *    ONNX nor LLM are available.
 *
 * The guardrail is configured as Phase 2 (parallel, non-sanitizing) so it runs
 * alongside other read-only guardrails without blocking the streaming pipeline.
 *
 * ### Action thresholds
 *
 * - **FLAG** when any category confidence exceeds `flagThreshold` (default 0.5).
 * - **BLOCK** when any category confidence exceeds `blockThreshold` (default 0.8).
 *
 * @module ml-classifiers/MLClassifierGuardrail
 */

import type {
  IGuardrailService,
  GuardrailConfig,
  GuardrailInputPayload,
  GuardrailOutputPayload,
  GuardrailEvaluationResult,
  AgentOSFinalResponseChunk,
} from '@framers/agentos';
import { GuardrailAction } from '@framers/agentos';
import { AgentOSResponseChunkType } from '@framers/agentos';
import type {
  MLClassifierOptions,
  MLClassifierLogger,
  ClassifierCategory,
  ClassifierResult,
  CategoryScore,
} from './types.js';
import { ALL_CATEGORIES } from './types.js';
import { classifyByKeywords } from './keyword-classifier.js';
import { classifyByLlm } from './llm-classifier.js';

// ---------------------------------------------------------------------------
// HuggingFace / ONNX pipeline types
// ---------------------------------------------------------------------------

/**
 * A single label + score pair returned by a HuggingFace text-classification
 * pipeline.  The `label` is the model's class name (e.g. `"toxic"`,
 * `"obscene"`) and `score` is the softmax probability in [0, 1].
 */
interface OnnxClassificationLabel {
  label: string;
  score: number;
}

/**
 * Callable returned by `pipeline('text-classification', ...)` from the
 * `@huggingface/transformers` package.  Returns all label scores for the
 * given text.
 */
type OnnxTextClassificationPipeline = (text: string) => Promise<OnnxClassificationLabel[]>;

// ---------------------------------------------------------------------------
// MLClassifierGuardrail
// ---------------------------------------------------------------------------

/**
 * AgentOS guardrail that classifies text for safety using ML models, LLM
 * inference, or keyword fallback.
 *
 * @implements {IGuardrailService}
 */
export class MLClassifierGuardrail implements IGuardrailService {
  // -----------------------------------------------------------------------
  // IGuardrailService.config
  // -----------------------------------------------------------------------

  /**
   * Guardrail configuration.
   *
   * - `canSanitize: false` — this guardrail does not modify content; it only
   *   BLOCKs or FLAGs.  This places it in Phase 2 (parallel) of the guardrail
   *   dispatcher for better performance.
   * - `evaluateStreamingChunks: false` — only evaluates complete messages, not
   *   individual streaming deltas.  ML classification on partial text produces
   *   unreliable results.
   */
  readonly config: GuardrailConfig = {
    canSanitize: false,
    evaluateStreamingChunks: false,
  };

  // -----------------------------------------------------------------------
  // Private state
  // -----------------------------------------------------------------------

  /** Categories to evaluate. */
  private readonly categories: ClassifierCategory[];

  /** Per-category flag thresholds. */
  private readonly flagThresholds: Record<ClassifierCategory, number>;

  /** Per-category block thresholds. */
  private readonly blockThresholds: Record<ClassifierCategory, number>;

  /** Optional LLM invoker callback for tier-2 classification. */
  private readonly llmInvoker: MLClassifierOptions['llmInvoker'];

  /**
   * Cached reference to the `@huggingface/transformers` pipeline function.
   * `null` means we already tried and failed to load the module.
   * `undefined` means we have not tried yet.
   */
  private onnxPipeline: OnnxTextClassificationPipeline | null | undefined = undefined;

  /**
   * The one load of the ONNX pipeline. Classifications that start before it
   * settles wait for the same load, so the model loads once and an
   * unavailable tier is reported once.
   */
  private onnxLoad: Promise<void> | undefined = undefined;

  /** The host's logger, for the one line about an unavailable ONNX tier. */
  private readonly logger: MLClassifierLogger | undefined;

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  /**
   * Create a new MLClassifierGuardrail.
   *
   * @param options - Pack-level configuration.  All properties have sensible
   *                  defaults for zero-config operation.
   * @param logger - The host's logger; the console when left out.
   */
  constructor(options?: MLClassifierOptions, logger?: MLClassifierLogger) {
    const opts = options ?? {};
    this.logger = logger;

    this.categories = opts.categories ?? [...ALL_CATEGORIES];
    this.llmInvoker = opts.llmInvoker;

    // Resolve per-category thresholds.
    const globalFlag = opts.flagThreshold ?? 0.5;
    const globalBlock = opts.blockThreshold ?? 0.8;

    this.flagThresholds = {} as Record<ClassifierCategory, number>;
    this.blockThresholds = {} as Record<ClassifierCategory, number>;

    for (const cat of ALL_CATEGORIES) {
      this.flagThresholds[cat] = opts.thresholds?.[cat]?.flag ?? globalFlag;
      this.blockThresholds[cat] = opts.thresholds?.[cat]?.block ?? globalBlock;
    }
  }

  // -----------------------------------------------------------------------
  // IGuardrailService — evaluateInput
  // -----------------------------------------------------------------------

  /**
   * Evaluate user input for safety before orchestration begins.
   *
   * @param payload - Input evaluation payload containing the user's message.
   * @returns Guardrail result or `null` if no action is required.
   */
  async evaluateInput(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    const text = payload.input.textInput;
    if (!text || text.length === 0) return null;

    const result = await this.classify(text);
    return this.buildResult(result);
  }

  // -----------------------------------------------------------------------
  // IGuardrailService — evaluateOutput
  // -----------------------------------------------------------------------

  /**
   * Evaluate agent output for safety.  Only processes FINAL_RESPONSE chunks
   * since `evaluateStreamingChunks` is disabled.
   *
   * @param payload - Output evaluation payload from the AgentOS dispatcher.
   * @returns Guardrail result or `null` if no action is required.
   */
  async evaluateOutput(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    const { chunk } = payload;

    // Only evaluate final text responses.
    if (chunk.type !== AgentOSResponseChunkType.FINAL_RESPONSE) {
      return null;
    }

    const finalChunk = chunk as AgentOSFinalResponseChunk;
    const text = finalChunk.finalResponseText ?? '';
    if (typeof text !== 'string' || text.length === 0) return null;

    const result = await this.classify(text);
    return this.buildResult(result);
  }

  // -----------------------------------------------------------------------
  // Public classification method (also used by ClassifyContentTool)
  // -----------------------------------------------------------------------

  /**
   * Classify a text string using the three-tier strategy: ONNX -> LLM -> keyword.
   *
   * @param text - The text to classify.
   * @returns Classification result with per-category scores.
   */
  async classify(text: string): Promise<ClassifierResult> {
    // Tier 1: try ONNX inference.
    const onnxResult = await this.tryOnnxClassification(text);
    if (onnxResult) return onnxResult;

    // Tier 2: try LLM-as-judge.
    if (this.llmInvoker) {
      const llmResult = await this.tryLlmClassification(text);
      if (llmResult) return llmResult;
    }

    // Tier 3: keyword fallback.
    const scores = classifyByKeywords(text, this.categories);
    return {
      categories: scores,
      flagged: scores.some((s) => s.confidence > this.flagThresholds[s.name]),
      source: 'keyword',
    };
  }

  // -----------------------------------------------------------------------
  // Private — ONNX classification (Tier 1)
  // -----------------------------------------------------------------------

  /**
   * Attempt to load `@huggingface/transformers` and run ONNX-based text
   * classification.  Returns `null` if the module is unavailable or inference
   * fails.
   *
   * The module load is attempted only once; subsequent calls use the cached
   * result (either a working pipeline or `null`).
   *
   * @param text - Text to classify.
   * @returns Classification result or `null`.
   *
   * @internal
   */
  private async tryOnnxClassification(text: string): Promise<ClassifierResult | null> {
    // If we already know ONNX is unavailable, skip.
    if (this.onnxPipeline === null) return null;

    // First-time load attempt, shared by every classification that starts before it settles.
    if (this.onnxPipeline === undefined) {
      this.onnxLoad ??= this.loadOnnxPipeline();
      await this.onnxLoad;
    }
    if (!this.onnxPipeline) return null;

    try {
      const raw = await this.onnxPipeline(text);

      // Map ONNX labels to our categories.
      const scores = this.mapOnnxScores(raw);
      return {
        categories: scores,
        flagged: scores.some((s) => s.confidence > this.flagThresholds[s.name]),
        source: 'onnx',
      };
    } catch {
      // Inference failed — fall through to next tier.
      return null;
    }
  }

  /**
   * Loads the ONNX pipeline once: a working pipeline, or `null` with the one
   * warning when the module or the model cannot load.
   *
   * @internal
   */
  private async loadOnnxPipeline(): Promise<void> {
    try {
      // Dynamic import so the optional dependency does not fail at boot.
      const transformers = await import('@huggingface/transformers');
      const pipelineInstance = await transformers.pipeline(
        'text-classification',
        'Xenova/toxic-bert',
        { device: 'cpu' }
      );
      // The HuggingFace pipeline is callable as a function. We always
      // request all labels (top_k higher than any model's label count
      // causes HF to return every label, matching `top_k: null`).
      // Cast through unknown because the Pipeline union type is too
      // wide for the inferred call signature here.
      const callable = pipelineInstance as unknown as (
        text: string,
        opts: { top_k: number },
      ) => Promise<OnnxClassificationLabel[]>;
      this.onnxPipeline = (text: string) => callable(text, { top_k: 9999 });
    } catch (error) {
      // Module not installed or model load failed — mark as unavailable,
      // and say so once for this guardrail.
      this.onnxPipeline = null;
      this.logOnnxUnavailable(error);
    }
  }

  /**
   * Writes, once for this guardrail (the load is tried once), that the ONNX
   * tier is unavailable, why, and which tier classifies instead.
   *
   * @param error - What the import or the model load threw.
   *
   * @internal
   */
  private logOnnxUnavailable(error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const next = this.llmInvoker
      ? 'the LLM tier (llmInvoker), then the keyword tier'
      : 'the keyword tier';
    const line = `ml-classifiers: the ONNX tier is unavailable (Xenova/toxic-bert could not load: ${reason}); classifying with ${next}`;
    if (this.logger) this.logger.warn(line);
    else console.warn(line);
  }

  /**
   * Map raw ONNX text-classification output labels to our standard categories.
   *
   * ONNX models (e.g. toxic-bert) produce labels like `"toxic"`, `"obscene"`,
   * `"threat"`, `"insult"`, `"identity_hate"`, etc.  We map these to our four
   * categories, taking the max score when multiple ONNX labels map to the same
   * category.
   *
   * @param raw - Raw ONNX pipeline output.
   * @returns Per-category scores.
   *
   * @internal
   */
  private mapOnnxScores(raw: OnnxClassificationLabel[]): CategoryScore[] {
    /** Map of ONNX label -> our category. */
    const labelMap: Record<string, ClassifierCategory> = {
      toxic: 'toxic',
      severe_toxic: 'toxic',
      obscene: 'nsfw',
      insult: 'toxic',
      identity_hate: 'toxic',
      threat: 'threat',
    };

    const maxScores: Record<ClassifierCategory, number> = {
      toxic: 0,
      injection: 0,
      nsfw: 0,
      threat: 0,
    };

    for (const item of raw) {
      const label = (item.label ?? '').toLowerCase().replace(/\s+/g, '_');
      const score = typeof item.score === 'number' ? item.score : 0;
      const cat = labelMap[label];
      if (cat && score > maxScores[cat]) {
        maxScores[cat] = score;
      }
    }

    // ONNX models typically do not detect prompt injection; leave at 0.
    return this.categories.map((name) => ({
      name,
      confidence: maxScores[name] ?? 0,
    }));
  }

  // -----------------------------------------------------------------------
  // Private — LLM classification (Tier 2)
  // -----------------------------------------------------------------------

  /**
   * Classify text using the LLM-as-judge fallback.
   *
   * @param text - Text to classify.
   * @returns Classification result or `null` if the LLM call fails.
   *
   * @internal
   */
  private async tryLlmClassification(text: string): Promise<ClassifierResult | null> {
    if (!this.llmInvoker) return null;

    try {
      const scores = await classifyByLlm(text, this.llmInvoker, this.categories);

      // If all scores are zero the LLM likely failed to parse — treat as null.
      if (scores.every((s) => s.confidence === 0)) return null;

      return {
        categories: scores,
        flagged: scores.some((s) => s.confidence > this.flagThresholds[s.name]),
        source: 'llm',
      };
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Private — result builder
  // -----------------------------------------------------------------------

  /**
   * Convert a {@link ClassifierResult} into a {@link GuardrailEvaluationResult},
   * or return `null` when no thresholds are exceeded.
   *
   * @param result - Classification result from any tier.
   * @returns Guardrail evaluation result or `null`.
   *
   * @internal
   */
  private buildResult(result: ClassifierResult): GuardrailEvaluationResult | null {
    // Check for BLOCK-level violations first.
    const blockers = result.categories.filter((s) => s.confidence > this.blockThresholds[s.name]);

    if (blockers.length > 0) {
      const worst = blockers.reduce((a, b) => (b.confidence > a.confidence ? b : a));

      return {
        action: GuardrailAction.BLOCK,
        reason: `ML classifier detected unsafe content: ${blockers.map((b) => `${b.name}(${b.confidence.toFixed(2)})`).join(', ')}`,
        reasonCode: `ML_CLASSIFIER_${worst.name.toUpperCase()}`,
        metadata: {
          source: result.source,
          categories: result.categories,
        },
      };
    }

    // Check for FLAG-level violations.
    const flaggers = result.categories.filter((s) => s.confidence > this.flagThresholds[s.name]);

    if (flaggers.length > 0) {
      const worst = flaggers.reduce((a, b) => (b.confidence > a.confidence ? b : a));

      return {
        action: GuardrailAction.FLAG,
        reason: `ML classifier flagged content: ${flaggers.map((f) => `${f.name}(${f.confidence.toFixed(2)})`).join(', ')}`,
        reasonCode: `ML_CLASSIFIER_${worst.name.toUpperCase()}`,
        metadata: {
          source: result.source,
          categories: result.categories,
        },
      };
    }

    // No thresholds exceeded — allow.
    return null;
  }
}
