// @ts-nocheck
/**
 * @file CheckTopicTool.ts
 * @description On-demand topic classification tool that allows agents and
 * workflows to explicitly check whether a given text is on-topic before
 * responding.
 *
 * Unlike the {@link TopicalityGuardrail} (which runs automatically in the
 * guardrail pipeline), this tool is invoked explicitly via a tool call,
 * enabling agents to self-check user messages or draft responses against
 * the configured topic boundaries.
 *
 * @module agentos/extensions/packs/topicality/tools/CheckTopicTool
 */

import type {
  ITool,
  ToolExecutionContext,
  ToolExecutionResult,
  JSONSchemaObject,
} from '@framers/agentos';
import type { TopicMatchResult } from '../types.js';
import type { TopicalityGuardrail } from '../TopicalityGuardrail.js';

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/**
 * Input arguments for the `check_topic` tool.
 */
export interface CheckTopicInput {
  /**
   * The text to classify against the configured topic boundaries.
   */
  text: string;
}

// ---------------------------------------------------------------------------
// CheckTopicTool
// ---------------------------------------------------------------------------

/**
 * Tool that classifies a text string against the configured allowed and
 * blocked topic lists, returning a structured {@link TopicMatchResult}.
 *
 * Delegates to the same three-tier evaluation strategy used by
 * {@link TopicalityGuardrail}: embedding similarity, LLM-as-judge,
 * and keyword matching.
 */
export class CheckTopicTool implements ITool {
  /** Canonical tool name registered in the tool list. */
  readonly name = 'check_topic';

  /** Human-readable description shown to agents discovering this tool. */
  readonly description =
    'Check whether a text message is on-topic or off-topic relative to the configured allowed/blocked topic lists. Returns { onTopic, confidence, detectedTopic }.';

  /**
   * JSON Schema for the tool's input parameters.
   */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to classify for topic relevance.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  };

  /** Reference to the guardrail instance for reusing evaluation logic. */
  private readonly guardrail: TopicalityGuardrail;

  /**
   * @param guardrail - The guardrail instance whose evaluation methods
   *                    are reused for topic classification.
   */
  constructor(guardrail: TopicalityGuardrail) {
    this.guardrail = guardrail;
  }

  /**
   * Execute the topic check.
   *
   * Constructs a minimal {@link GuardrailInputPayload} and delegates to the
   * guardrail's `evaluateInput` method, then converts the result into the
   * tool's output shape.
   *
   * @param input - Tool input containing the text to classify.
   * @param _context - Tool execution context (unused).
   * @returns A {@link ToolExecutionResult} wrapping a {@link TopicMatchResult}.
   */
  async execute(
    input: CheckTopicInput,
    _context?: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    // Build a minimal input payload for the guardrail
    const payload = {
      context: {
        userId: 'tool-caller',
        sessionId: 'tool-session',
      },
      input: {
        textInput: input.text,
      },
    };

    const evalResult = await this.guardrail.evaluateInput(payload as never);

    // If the guardrail returned null, the text is on-topic
    if (!evalResult) {
      const result: TopicMatchResult = {
        onTopic: true,
        confidence: 1.0,
        detectedTopic: 'allowed',
      };
      return { output: result };
    }

    // Extract the metadata from the guardrail result
    const meta = evalResult.metadata as Record<string, unknown> | undefined;
    const result: TopicMatchResult = {
      onTopic: false,
      confidence: typeof meta?.confidence === 'number' ? meta.confidence : 0,
      detectedTopic: typeof meta?.detectedTopic === 'string' ? meta.detectedTopic : 'unknown',
    };

    return { output: result };
  }
}
