// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { ContentPolicyRewriterGuardrail } from '../src/ContentPolicyRewriterGuardrail.js';

describe('ContentPolicyRewriterGuardrail', () => {
  it('has correct guardrail config', () => {
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: vi.fn(),
      categories: { profanity: { enabled: true } },
    });
    expect(g.config.canSanitize).toBe(true);
    expect(g.config.evaluateStreamingChunks).toBe(true);
  });

  it('allows clean streaming chunk', async () => {
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: vi.fn(),
      categories: { profanity: { enabled: true } },
    });
    const result = await g.evaluateOutput({
      chunk: { type: 'TEXT_DELTA', text: 'Hello world' },
    });
    expect(result).toBeNull();
  });

  it('blocks streaming chunk with keyword match', async () => {
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: vi.fn(),
      categories: { profanity: { enabled: true, action: 'block' } },
    });
    const result = await g.evaluateOutput({
      chunk: { type: 'TEXT_DELTA', text: 'What the fuck' },
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('block');
  });

  it('sanitizes final response via LLM', async () => {
    const mockLlm = vi.fn();
    mockLlm.mockResolvedValueOnce('{ "violations": [{ "category": "profanity", "severity": "medium", "spans": ["damn"] }] }');
    mockLlm.mockResolvedValueOnce('The person was very upset.');

    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: mockLlm,
      categories: { profanity: { enabled: true, action: 'sanitize' } },
    });
    const result = await g.evaluateOutput({
      chunk: { type: 'FINAL_RESPONSE', finalResponseText: 'The person was damn upset.' },
    });
    expect(result).not.toBeNull();
    expect(result!.action).toBe('sanitize');
    expect(result!.modifiedText).toBe('The person was very upset.');
  });

  it('allows clean final response (no LLM rewrite call)', async () => {
    const mockLlm = vi.fn();
    mockLlm.mockResolvedValueOnce('{ "violations": [] }');

    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: mockLlm,
      categories: { profanity: { enabled: true } },
    });
    const result = await g.evaluateOutput({
      chunk: { type: 'FINAL_RESPONSE', finalResponseText: 'Everything is fine.' },
    });
    expect(result).toBeNull();
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it('returns null when no categories enabled', async () => {
    // illegal_harmful is on by default, so every category is turned off by name here.
    const mockLlm = vi.fn();
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: mockLlm,
      categories: { illegal_harmful: { enabled: false } },
    });
    const result = await g.evaluateOutput({
      chunk: { type: 'FINAL_RESPONSE', finalResponseText: 'Anything goes.' },
    });
    expect(result).toBeNull();
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('blocks with JUDGE_FAILED when the default category is on and the judge returns nothing', async () => {
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: vi.fn(),
      categories: {},
    });
    const result = await g.evaluateOutput({
      chunk: { type: 'FINAL_RESPONSE', finalResponseText: 'Anything goes.' },
    });
    expect(result).toEqual({ action: 'block', reasonCode: 'JUDGE_FAILED' });
  });
});
