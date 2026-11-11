// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { createRequire as createPackageRequire } from 'node:module';

// transformers.js unavailable, as when it is not installed: the guardrail takes the
// keyword tier and the test downloads no model.
vi.mock('@huggingface/transformers', () => {
  throw new Error('Module not found: @huggingface/transformers');
});

import { createExtensionPack } from '../src/index';

describe('Topicality Extension Pack', () => {
  // -------------------------------------------------------------------------
  // Pack structure
  // -------------------------------------------------------------------------

  it('createExtensionPack returns correct structure', () => {
    const pack = createExtensionPack({
      options: {
        allowedTopics: ['billing', 'support'],
        blockedTopics: ['violence'],
      },
    } as any);

    expect(pack.name).toBe('topicality');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(2);

    const kinds = pack.descriptors.map((d) => d.kind);
    expect(kinds).toContain('guardrail');
    expect(kinds).toContain('tool');

    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('topicality-guardrail');
    expect(ids).toContain('check_topic');
  });

  // -------------------------------------------------------------------------
  // Guardrail — keyword matching (no ONNX in tests)
  // -------------------------------------------------------------------------

  describe('guardrail evaluateInput (keyword fallback)', () => {
    function getGuardrail(allowed: string[], blocked: string[]) {
      const pack = createExtensionPack({
        options: { allowedTopics: allowed, blockedTopics: blocked },
      } as any);
      const desc = pack.descriptors.find((d) => d.kind === 'guardrail');
      return desc!.payload as any;
    }

    it('blocks input matching a blocked topic', async () => {
      const guardrail = getGuardrail(['billing'], ['violence']);
      const result = await guardrail.evaluateInput({
        input: { textInput: 'Tell me about violence' },
      });

      expect(result).not.toBeNull();
      expect(result!.action).toBe('block');
      expect(result!.reasonCode).toBe('BLOCKED_TOPIC');
    });

    it('allows input matching an allowed topic', async () => {
      const guardrail = getGuardrail(['billing', 'support'], ['violence']);
      const result = await guardrail.evaluateInput({
        input: { textInput: 'I have a billing question' },
      });

      expect(result).toBeNull();
    });

    it('flags input that matches no allowed topic', async () => {
      const guardrail = getGuardrail(['billing'], ['violence']);
      const result = await guardrail.evaluateInput({
        input: { textInput: 'Tell me about quantum physics' },
      });

      expect(result).not.toBeNull();
      expect(result!.action).toBe('flag');
      expect(result!.reasonCode).toBe('OFF_TOPIC');
    });
  });
});
