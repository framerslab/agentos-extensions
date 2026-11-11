// @ts-nocheck
/**
 * @file ClassifyContentTool.ts
 * @description An AgentOS tool that exposes the ML classifier as a callable tool,
 * enabling agents to perform on-demand safety classification of arbitrary text.
 *
 * @module ml-classifiers/tools/ClassifyContentTool
 */

import type { ITool, ToolExecutionContext, ToolExecutionResult } from '@framers/agentos';
import type { MLClassifierGuardrail } from '../MLClassifierGuardrail.js';
import type { CategoryScore } from '../types.js';

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/**
 * Input arguments accepted by {@link ClassifyContentTool}.
 */
export interface ClassifyContentInput {
  /** The text to classify for safety. */
  text: string;
}

/**
 * Output shape returned by {@link ClassifyContentTool}.
 */
export interface ClassifyContentOutput {
  /** Per-category confidence scores. */
  categories: CategoryScore[];

  /** `true` when at least one category exceeds the flag threshold. */
  flagged: boolean;
}

// ---------------------------------------------------------------------------
// ClassifyContentTool
// ---------------------------------------------------------------------------

/**
 * AgentOS tool that classifies text for toxicity, injection, NSFW, and threat
 * content using the same three-tier strategy as the guardrail.
 *
 * @implements {ITool<ClassifyContentInput, ClassifyContentOutput>}
 */
export class ClassifyContentTool implements ITool<ClassifyContentInput, ClassifyContentOutput> {
  // -----------------------------------------------------------------------
  // ITool metadata
  // -----------------------------------------------------------------------

  /** Stable tool identifier. */
  readonly id = 'classify_content';

  /** Tool name presented to the LLM. */
  readonly name = 'classify_content';

  /** Human-readable display name. */
  readonly displayName = 'ML Content Classifier';

  /** Description used by the LLM to decide when to invoke the tool. */
  readonly description =
    'Classify text for safety across four categories: toxic, injection, nsfw, and threat. ' +
    'Returns per-category confidence scores and a flagged boolean. Use this tool to ' +
    'pre-screen user-generated content or agent output before further processing.';

  /** Tool category for capability discovery grouping. */
  readonly category = 'security';

  /** Semantic version. */
  readonly version = '1.0.0';

  /** Read-only analysis — no side effects. */
  readonly hasSideEffects = false;

  /** JSON Schema for tool input validation. */
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string' as const,
        description: 'The text to classify for safety.',
      },
    },
    required: ['text'],
  };

  // -----------------------------------------------------------------------
  // Private fields
  // -----------------------------------------------------------------------

  /** The guardrail instance used for classification. */
  private readonly guardrail: MLClassifierGuardrail;

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  /**
   * Create a new ClassifyContentTool.
   *
   * @param guardrail - The {@link MLClassifierGuardrail} instance to delegate
   *                    classification to.  Shared and stateless (except for the
   *                    cached ONNX pipeline).
   */
  constructor(guardrail: MLClassifierGuardrail) {
    this.guardrail = guardrail;
  }

  // -----------------------------------------------------------------------
  // ITool.execute
  // -----------------------------------------------------------------------

  /**
   * Execute the classification against the provided text.
   *
   * @param args    - Validated input arguments containing `text`.
   * @param context - Tool execution context (unused by this read-only tool).
   * @returns Tool execution result wrapping the classification output.
   */
  async execute(
    args: ClassifyContentInput,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<ClassifyContentOutput>> {
    try {
      const result = await this.guardrail.classify(args.text);

      return {
        success: true,
        output: {
          categories: result.categories,
          flagged: result.flagged,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error during classification';

      return {
        success: false,
        error: `Content classification failed: ${message}`,
      };
    }
  }
}
