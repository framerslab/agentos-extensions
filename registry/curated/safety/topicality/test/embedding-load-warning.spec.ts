/**
 * @file embedding-load-warning.spec.ts
 * @description The embedding tier when `@huggingface/transformers` imports but
 * the embedding model fails to load (no network, a missing weight file). The
 * guardrail falls to the next tier and says so in one warning per guardrail
 * instance, through the host's logger, else the console.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// A plain function, not vi.fn(): vi.restoreAllMocks() in afterEach would strip a
// vi.fn()'s rejection and leave a pipeline that loads as undefined.
vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => {
    throw new Error('Could not locate file: "onnx/model_quantized.onnx"');
  },
}));

import { TopicalityGuardrail } from '../src/TopicalityGuardrail';
import { createExtensionPack } from '../src/index';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function input(textInput: string): any {
  return {
    context: { userId: 'user-1', sessionId: 'session-1' },
    input: { userId: 'user-1', sessionId: 'session-1', textInput },
  };
}

const TOPICS = { allowedTopics: ['billing'], blockedTopics: ['politics'] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an embedding tier whose model fails to load', () => {
  it('warns once through the host logger with the error, and decides with the keyword tier', async () => {
    const log = logger();
    const guardrail = new TopicalityGuardrail(TOPICS, log);

    const blocked = await guardrail.evaluateInput(input('Tell me about politics'));
    const allowed = await guardrail.evaluateInput(input('I have a billing question'));

    expect(blocked?.action).toBe('block');
    expect(blocked?.reasonCode).toBe('BLOCKED_TOPIC');
    expect(allowed).toBeNull();

    expect(log.warn).toHaveBeenCalledTimes(1);
    const line = String(log.warn.mock.calls[0][0]);
    expect(line).toContain('embedding tier is unavailable');
    expect(line).toContain('Could not locate file');
    expect(line).toContain('keyword tier');
  });

  it('warns once for each guardrail instance, with the error, after the load has already failed', async () => {
    const a = logger();
    const b = logger();

    await new TopicalityGuardrail(TOPICS, a).evaluateInput(input('Tell me about politics'));
    const second = new TopicalityGuardrail(TOPICS, b);
    await second.evaluateInput(input('Tell me about politics'));
    await second.evaluateInput(input('I have a billing question'));

    expect(a.warn).toHaveBeenCalledTimes(1);
    expect(b.warn).toHaveBeenCalledTimes(1);
    expect(String(b.warn.mock.calls[0][0])).toContain('Could not locate file');
  });

  it('names the LLM tier when an llmInvoker is configured', async () => {
    const log = logger();
    const llmInvoker = vi
      .fn()
      .mockResolvedValue('{ "onTopic": true, "confidence": 0.9, "detectedTopic": "billing" }');
    const guardrail = new TopicalityGuardrail({ ...TOPICS, llmInvoker }, log);

    await expect(guardrail.evaluateInput(input('I have a billing question'))).resolves.toBeNull();

    expect(llmInvoker).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain('LLM tier');
  });

  it('takes the logger from the pack context', async () => {
    const log = logger();
    const pack = createExtensionPack({ options: TOPICS, logger: log } as any);
    const guardrail = pack.descriptors.find((d) => d.kind === 'guardrail')!.payload as any;

    await guardrail.evaluateInput(input('Tell me about politics'));

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('writes to the console when the host gives no logger', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const guardrail = new TopicalityGuardrail(TOPICS);

    await guardrail.evaluateInput(input('Tell me about politics'));
    await guardrail.evaluateInput(input('I have a billing question'));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('embedding tier is unavailable');
  });
});
