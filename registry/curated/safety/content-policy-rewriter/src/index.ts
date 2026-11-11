// @ts-nocheck
/**
 * @fileoverview Content Policy Rewriter — extension pack factory.
 *
 * Opt-in guardrail that detects content policy violations in agent output
 * and either blocks or rewrites them via LLM. Agents are uncensored by
 * default — this extension only activates when explicitly configured.
 *
 * @module content-policy-rewriter
 */

import type { ContentPolicyRewriterConfig, LlmInvoker } from './types.js';
import { ContentPolicyRewriterGuardrail } from './ContentPolicyRewriterGuardrail.js';
import { resolvePreset } from './presets.js';
import { PACKAGE_VERSION } from './packageVersion.js';

export * from './types.js';
export { ContentPolicyRewriterGuardrail } from './ContentPolicyRewriterGuardrail.js';
export { KeywordPreFilter } from './KeywordPreFilter.js';
export { LlmPolicyJudge } from './LlmPolicyJudge.js';
export { LlmRewriter } from './LlmRewriter.js';
export { resolvePreset } from './presets.js';

/**
 * Create the content policy rewriter extension pack.
 *
 * @param config - Policy configuration or preset name.
 * @param llmInvoker - Callback to invoke an LLM for classification and rewriting.
 * @returns A configured ExtensionPack.
 */
export function createContentPolicyRewriter(
  config: ContentPolicyRewriterConfig | string = {},
  llmInvoker?: LlmInvoker,
) {
  const resolved = typeof config === 'string' ? resolvePreset(config as any) : config;

  const invoker: LlmInvoker = llmInvoker ?? resolved.llmInvoker ?? createDefaultInvoker(resolved);
  const guardrail = new ContentPolicyRewriterGuardrail({ ...resolved, llmInvoker: invoker });

  return {
    name: 'content-policy-rewriter',
    version: PACKAGE_VERSION,
    descriptors: [
      {
        id: 'content-policy-rewriter-guardrail',
        kind: 'guardrail' as const,
        priority: 3,
        payload: guardrail,
      },
    ],
  };
}

/** Manifest factory bridge for extension loader. */
export function createExtensionPack(context: any) {
  return createContentPolicyRewriter(
    context.options as ContentPolicyRewriterConfig,
    context.llmInvoker,
  );
}

/** Default LLM invoker using fetch to OpenAI-compatible API. */
function createDefaultInvoker(config: ContentPolicyRewriterConfig): LlmInvoker {
  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('No LLM API key for content policy judge');

    const isOpenRouter = !process.env.OPENAI_API_KEY && !!process.env.OPENROUTER_API_KEY;
    const baseUrl = isOpenRouter ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
    const model = config.llm?.model ?? (isOpenRouter ? 'anthropic/claude-haiku-4-5-20251001' : 'gpt-4o-mini');

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(isOpenRouter && { 'HTTP-Referer': 'https://agentos.sh' }),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.1,
      }),
    });

    if (!res.ok) throw new Error(`LLM API returned ${res.status}`);
    const data = (await res.json()) as any;
    return data.choices?.[0]?.message?.content ?? '';
  };
}
