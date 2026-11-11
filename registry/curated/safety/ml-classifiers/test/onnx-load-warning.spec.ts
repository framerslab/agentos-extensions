/**
 * @file onnx-load-warning.spec.ts
 * @description The ONNX tier when `@huggingface/transformers` imports but the
 * model fails to load (no network, a missing weight file). The guardrail falls
 * to the next tier and says so in one warning per guardrail instance, through
 * the host's logger, else the console.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// A plain function, not vi.fn(): vi.restoreAllMocks() in afterEach would strip a
// vi.fn()'s rejection and leave a pipeline that loads as undefined.
vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => {
    throw new Error('Could not locate file: "onnx/model_quantized.onnx"');
  },
}));

import { MLClassifierGuardrail } from '../src/MLClassifierGuardrail';
import { createExtensionPack, createMLClassifierGuardrail } from '../src/index';
import type { LlmInvoker } from '../src/types';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function guardrailOf(pack: { descriptors: Array<{ kind: string; payload: unknown }> }): any {
  return pack.descriptors.find((descriptor) => descriptor.kind === 'guardrail')!.payload;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an ONNX tier whose model fails to load', () => {
  it('warns once through the host logger with the error, and classifies with the keyword tier', async () => {
    const log = logger();
    const guardrail = new MLClassifierGuardrail(undefined, log);

    const first = await guardrail.classify('kill yourself you stupid ass idiot');
    const second = await guardrail.classify('What is the weather like today?');

    expect(first.source).toBe('keyword');
    expect(first.flagged).toBe(true);
    expect(second.source).toBe('keyword');
    expect(second.flagged).toBe(false);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const line = String(log.warn.mock.calls[0][0]);
    expect(line).toContain('ONNX tier is unavailable');
    expect(line).toContain('Could not locate file');
    expect(line).toContain('keyword tier');
  });

  it('names the LLM tier when an llmInvoker is configured', async () => {
    const log = logger();
    const invoker: LlmInvoker = vi.fn().mockResolvedValue(
      JSON.stringify({ toxic: true, injection: false, nsfw: false, threat: false, confidence: 0.9 })
    );
    const guardrail = new MLClassifierGuardrail({ llmInvoker: invoker }, log);

    const result = await guardrail.classify('some text');

    expect(result.source).toBe('llm');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain('LLM tier');
  });

  it('warns once for each guardrail instance', async () => {
    const a = logger();
    const b = logger();
    const first = new MLClassifierGuardrail(undefined, a);
    const second = new MLClassifierGuardrail(undefined, b);

    await first.classify('one');
    await first.classify('two');
    await second.classify('three');

    expect(a.warn).toHaveBeenCalledTimes(1);
    expect(b.warn).toHaveBeenCalledTimes(1);
  });

  it('takes the logger from the pack context', async () => {
    const log = logger();
    const guardrail = guardrailOf(createExtensionPack({ options: {}, logger: log } as any));

    await guardrail.evaluateInput({ input: { textInput: 'What is the weather like today?' } });

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("takes the activation context's logger when the pack was created without one", async () => {
    const log = logger();
    const pack = createMLClassifierGuardrail();
    await pack.onActivate?.({ logger: log } as any);

    await guardrailOf(pack).evaluateInput({ input: { textInput: 'What is the weather like today?' } });

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('writes to the console when the host gives no logger', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const guardrail = new MLClassifierGuardrail();

    await guardrail.classify('one');
    await guardrail.classify('two');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ONNX tier is unavailable');
  });
});
