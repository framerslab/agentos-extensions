// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';
import { createRequire as createPackageRequire } from 'node:module';

// transformers.js unavailable, as when it is not installed: the guardrail takes the
// keyword tier and the test downloads no model.
vi.mock('@huggingface/transformers', () => {
  throw new Error('Module not found: @huggingface/transformers');
});

import { createExtensionPack } from '../src/index';

describe('ML Classifiers Extension Pack', () => {
  // -------------------------------------------------------------------------
  // Pack structure
  // -------------------------------------------------------------------------

  it('createExtensionPack returns correct structure', () => {
    const pack = createExtensionPack({ options: {} } as any);

    expect(pack.name).toBe('ml-classifiers');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(2);

    const kinds = pack.descriptors.map((d) => d.kind);
    expect(kinds).toContain('guardrail');
    expect(kinds).toContain('tool');

    const ids = pack.descriptors.map((d) => d.id);
    expect(ids).toContain('ml-classifier-guardrail');
    expect(ids).toContain('classify_content');
  });

  // -------------------------------------------------------------------------
  // Guardrail — keyword fallback detection
  // -------------------------------------------------------------------------

  describe('guardrail evaluateInput', () => {
    function getGuardrail() {
      const pack = createExtensionPack({ options: {} } as any);
      const desc = pack.descriptors.find((d) => d.kind === 'guardrail');
      return desc!.payload as any;
    }

    it('detects highly toxic input', async () => {
      const guardrail = getGuardrail();
      // Use strongly toxic text that both ONNX and keyword fallback would flag
      const result = await guardrail.evaluateInput({
        input: { textInput: 'You are a stupid idiot, kill yourself you moron' },
      });

      expect(result).not.toBeNull();
      expect(['flag', 'block']).toContain(result!.action);
    });

    it('allows clean input through', async () => {
      const guardrail = getGuardrail();
      const result = await guardrail.evaluateInput({
        input: { textInput: 'What is the weather like today?' },
      });

      expect(result).toBeNull();
    });
  });
});
