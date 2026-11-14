/**
 * @file onnx-tier.spec.ts
 * @description Tests for the ONNX (Tier 1) classification path in MLClassifierGuardrail.
 *
 * Mocks `@huggingface/transformers` to return controlled toxic-bert label/score
 * pairs, verifying that ONNX results are mapped to internal categories, threshold
 * logic works, and the result carries `source: 'onnx'`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @huggingface/transformers
// ---------------------------------------------------------------------------

/**
 * Callable mock that stands in for the ONNX text-classification pipeline.
 * Tests configure its return value per-case via `mockResolvedValue`.
 */
const mockPipelineCall = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  // transformers.js returns a callable pipeline object, so the stand-in is a function.
  pipeline: vi.fn().mockResolvedValue((text: string, opts: unknown) => mockPipelineCall(text, opts)),
}));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import { MLClassifierGuardrail } from '../src/MLClassifierGuardrail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a fresh guardrail instance for each test (resets cached pipeline). */
function createGuardrail(options?: any): MLClassifierGuardrail {
  return new MLClassifierGuardrail(options);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ONNX tier classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Label mapping
  // -------------------------------------------------------------------------

  describe('label-to-category mapping', () => {
    it('maps toxic-bert labels to internal categories', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'toxic', score: 0.92 },
        { label: 'severe_toxic', score: 0.45 },
        { label: 'obscene', score: 0.78 },
        { label: 'insult', score: 0.65 },
        { label: 'identity_hate', score: 0.3 },
        { label: 'threat', score: 0.15 },
      ]);

      const guardrail = createGuardrail();
      const result = await guardrail.classify('test text');

      expect(result.source).toBe('onnx');

      // toxic = max(toxic:0.92, severe_toxic:0.45, insult:0.65, identity_hate:0.30)
      const toxic = result.categories.find((c) => c.name === 'toxic');
      expect(toxic?.confidence).toBe(0.92);

      // nsfw = max(obscene:0.78)
      const nsfw = result.categories.find((c) => c.name === 'nsfw');
      expect(nsfw?.confidence).toBe(0.78);

      // threat = max(threat:0.15)
      const threat = result.categories.find((c) => c.name === 'threat');
      expect(threat?.confidence).toBe(0.15);

      // injection is not produced by toxic-bert, stays at 0
      const injection = result.categories.find((c) => c.name === 'injection');
      expect(injection?.confidence).toBe(0);
    });

    it('takes max score when multiple ONNX labels map to the same category', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'toxic', score: 0.3 },
        { label: 'severe_toxic', score: 0.85 },
        { label: 'insult', score: 0.6 },
        { label: 'identity_hate', score: 0.7 },
        { label: 'obscene', score: 0.1 },
        { label: 'threat', score: 0.05 },
      ]);

      const guardrail = createGuardrail();
      const result = await guardrail.classify('some text');

      // toxic category = max(0.30, 0.85, 0.60, 0.70) = 0.85
      const toxic = result.categories.find((c) => c.name === 'toxic');
      expect(toxic?.confidence).toBe(0.85);
    });

    it('handles labels with mixed case and whitespace', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'Toxic', score: 0.7 },
        { label: 'OBSCENE', score: 0.6 },
        { label: 'identity hate', score: 0.5 },
        { label: 'THREAT', score: 0.3 },
        { label: 'severe toxic', score: 0.2 },
        { label: 'INSULT', score: 0.1 },
      ]);

      const guardrail = createGuardrail();
      const result = await guardrail.classify('some text');

      // identity_hate is "identity hate" with space -> lowered + underscore = identity_hate -> toxic
      // toxic = max(toxic:0.7, identity_hate:0.5, severe_toxic:0.2, insult:0.1) = 0.7
      const toxic = result.categories.find((c) => c.name === 'toxic');
      expect(toxic?.confidence).toBe(0.7);

      // obscene -> nsfw = 0.6
      const nsfw = result.categories.find((c) => c.name === 'nsfw');
      expect(nsfw?.confidence).toBe(0.6);
    });
  });

  // -------------------------------------------------------------------------
  // Threshold behaviour
  // -------------------------------------------------------------------------

  describe('threshold behaviour', () => {
    it('flags content above default flag threshold (0.5)', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'toxic', score: 0.65 },
        { label: 'severe_toxic', score: 0.0 },
        { label: 'obscene', score: 0.0 },
        { label: 'insult', score: 0.0 },
        { label: 'identity_hate', score: 0.0 },
        { label: 'threat', score: 0.0 },
      ]);

      const guardrail = createGuardrail();
      const result = await guardrail.classify('mildly toxic text');

      expect(result.flagged).toBe(true);
      expect(result.source).toBe('onnx');
    });

    it('does not flag content below all thresholds', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'toxic', score: 0.1 },
        { label: 'severe_toxic', score: 0.05 },
        { label: 'obscene', score: 0.02 },
        { label: 'insult', score: 0.08 },
        { label: 'identity_hate', score: 0.01 },
        { label: 'threat', score: 0.03 },
      ]);

      const guardrail = createGuardrail();
      const result = await guardrail.classify('perfectly clean text');

      expect(result.flagged).toBe(false);
      expect(result.source).toBe('onnx');
    });

    it('respects per-category threshold overrides', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'toxic', score: 0.35 },
        { label: 'severe_toxic', score: 0.0 },
        { label: 'obscene', score: 0.0 },
        { label: 'insult', score: 0.0 },
        { label: 'identity_hate', score: 0.0 },
        { label: 'threat', score: 0.0 },
      ]);

      // Lower the toxic flag threshold so 0.35 exceeds it
      const guardrail = createGuardrail({
        thresholds: { toxic: { flag: 0.3 } },
      });
      const result = await guardrail.classify('borderline text');

      expect(result.flagged).toBe(true);
    });

    it('does not flag when score equals the threshold exactly', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'toxic', score: 0.5 },
        { label: 'severe_toxic', score: 0.0 },
        { label: 'obscene', score: 0.0 },
        { label: 'insult', score: 0.0 },
        { label: 'identity_hate', score: 0.0 },
        { label: 'threat', score: 0.0 },
      ]);

      const guardrail = createGuardrail();
      const result = await guardrail.classify('edge case text');

      // Flag threshold is 0.5, score is exactly 0.5 -> ">" check, not ">="
      expect(result.flagged).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Result source
  // -------------------------------------------------------------------------

  describe('result source', () => {
    it('always returns source: onnx when pipeline succeeds', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'toxic', score: 0.0 },
        { label: 'severe_toxic', score: 0.0 },
        { label: 'obscene', score: 0.0 },
        { label: 'insult', score: 0.0 },
        { label: 'identity_hate', score: 0.0 },
        { label: 'threat', score: 0.0 },
      ]);

      const guardrail = createGuardrail();
      const result = await guardrail.classify('hello');

      expect(result.source).toBe('onnx');
    });
  });

  // -------------------------------------------------------------------------
  // All four categories present
  // -------------------------------------------------------------------------

  describe('category completeness', () => {
    it('returns scores for all four categories', async () => {
      mockPipelineCall.mockResolvedValue([
        { label: 'toxic', score: 0.1 },
        { label: 'severe_toxic', score: 0.0 },
        { label: 'obscene', score: 0.2 },
        { label: 'insult', score: 0.0 },
        { label: 'identity_hate', score: 0.0 },
        { label: 'threat', score: 0.3 },
      ]);

      const guardrail = createGuardrail();
      const result = await guardrail.classify('test');

      const names = result.categories.map((c) => c.name);
      expect(names).toContain('toxic');
      expect(names).toContain('injection');
      expect(names).toContain('nsfw');
      expect(names).toContain('threat');
      expect(result.categories).toHaveLength(4);
    });
  });
});
