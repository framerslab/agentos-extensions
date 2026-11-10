// @ts-nocheck
/**
 * @fileoverview Layer 2b: LLM-based content rewriter.
 * Takes text with identified violations and rewrites it to remove them.
 * @module content-policy-rewriter/LlmRewriter
 */

import type { LlmInvoker, PolicyViolation } from './types.js';

const SYSTEM_PROMPT = `Rewrite the following text to remove policy violations while preserving the original meaning, tone, and information content. Do not add disclaimers or commentary — just output the clean version.`;

export class LlmRewriter {
  constructor(private llmInvoker: LlmInvoker) {}

  /**
   * Rewrite the text. Returns the original text when the LLM call fails or returns nothing; use
   * {@link tryRewrite} to tell a failure from a rewrite.
   */
  async rewrite(text: string, violations: PolicyViolation[], customRules?: string): Promise<string> {
    if (violations.length === 0) return text;
    return (await this.tryRewrite(text, violations, customRules)) ?? text;
  }

  /**
   * Rewrite the text.
   * @returns The rewritten text, or null when the LLM call failed or returned no text.
   */
  async tryRewrite(text: string, violations: PolicyViolation[], customRules?: string): Promise<string | null> {
    const violationList = violations
      .map(v => {
        const spans = Array.isArray(v.spans) ? v.spans.filter(s => typeof s === 'string') : [];
        return spans.length > 0 ? `- ${v.category}: ${spans.map(s => `"${s}"`).join(', ')}` : `- ${v.category}`;
      })
      .join('\n');

    let userPrompt = `Violations to remove:\n${violationList}\n`;
    if (customRules) userPrompt += `\nAdditional rules: ${customRules}\n`;
    userPrompt += `\nOriginal text:\n"""\n${text}\n"""\n\nRewritten text:`;

    try {
      const raw = await this.llmInvoker(SYSTEM_PROMPT, userPrompt);
      const cleaned = String(raw ?? '').replace(/^```\w*\s*\n?/gm, '').replace(/\n?```\s*$/gm, '').trim();
      return cleaned || null;
    } catch {
      return null;
    }
  }
}
