/**
 * @file no-topics.spec.ts
 * @description The pack as a host loads it with no topics: a manifest entry
 * with no options, the registry's options (priority and secrets, no topics), or
 * empty lists. The guardrail passes every input, never throws, and says why in
 * one line through the host's logger (the console when the host gives none).
 * One list alone still enforces.
 *
 * transformers.js is made unavailable, as when it is not installed, so the
 * cases with topics take the keyword tier and download no model.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@huggingface/transformers', () => {
  throw new Error('transformers not installed');
});

import { createExtensionPack, createTopicalityGuardrail } from '../src/index';

type Logger = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function guardrailOf(pack: { descriptors: Array<{ kind: string; payload: unknown }> }): any {
  return pack.descriptors.find((descriptor) => descriptor.kind === 'guardrail')!.payload;
}

function toolOf(pack: { descriptors: Array<{ kind: string; payload: unknown }> }): any {
  return pack.descriptors.find((descriptor) => descriptor.kind === 'tool')!.payload;
}

function input(textInput: string): any {
  return {
    context: { userId: 'user-1', sessionId: 'session-1' },
    input: { userId: 'user-1', sessionId: 'session-1', textInput },
  };
}

/**
 * A guardrail with topics writes no line about missing topics; with
 * transformers.js unavailable it writes the one line about the embedding tier.
 */
function expectOnlyTheEmbeddingWarning(log: Logger): void {
  expect(log.warn).toHaveBeenCalledTimes(1);
  const line = String(log.warn.mock.calls[0][0]);
  expect(line).toContain('embedding tier is unavailable');
  expect(line).not.toContain('no allowedTopics or blockedTopics');
}

const MESSAGES = ['Tell me about violence', 'What is the weather in Paris?', 'My invoice is wrong'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a topicality guardrail with no topics', () => {
  it('passes every input from a manifest entry with no options, and says why once through the host logger', async () => {
    const log = logger();
    const pack = createExtensionPack({ logger: log } as any);
    await pack.onActivate?.({ logger: log } as any);
    const guardrail = guardrailOf(pack);

    for (const message of MESSAGES) {
      await expect(guardrail.evaluateInput(input(message))).resolves.toBeNull();
    }

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain('no allowedTopics or blockedTopics');
  });

  it('passes every input with the options the extensions registry gives a pack (priority and secrets)', async () => {
    const log = logger();
    const pack = createExtensionPack({
      options: { secrets: {}, priority: 6 },
      getSecret: () => undefined,
      logger: log,
    } as any);
    await pack.onActivate?.({ logger: log, getSecret: () => undefined } as any);
    const guardrail = guardrailOf(pack);

    for (const message of MESSAGES) {
      await expect(guardrail.evaluateInput(input(message))).resolves.toBeNull();
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('passes every input with empty lists', async () => {
    const log = logger();
    const pack = createExtensionPack({ options: { allowedTopics: [], blockedTopics: [] }, logger: log } as any);
    const guardrail = guardrailOf(pack);

    for (const message of MESSAGES) {
      await expect(guardrail.evaluateInput(input(message))).resolves.toBeNull();
    }
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('answers check_topic on topic', async () => {
    const pack = createExtensionPack({ logger: logger() } as any);
    const result = await toolOf(pack).execute({ text: 'Tell me about violence' });

    expect(result.output).toMatchObject({ onTopic: true });
  });

  it('writes the line to the console when the host gives no logger', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const guardrail = guardrailOf(createTopicalityGuardrail());

    await expect(guardrail.evaluateInput(input('Tell me about violence'))).resolves.toBeNull();
    await expect(guardrail.evaluateInput(input('What is the weather in Paris?'))).resolves.toBeNull();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('no allowedTopics or blockedTopics');
  });
});

describe('a topicality guardrail with one list', () => {
  it('blocks a blocked topic when only blockedTopics is given', async () => {
    const log = logger();
    const guardrail = guardrailOf(createExtensionPack({ options: { blockedTopics: ['violence'] }, logger: log } as any));

    const result = await guardrail.evaluateInput(input('Tell me about violence'));

    expect(result).not.toBeNull();
    expect(result.action).toBe('block');
    expect(result.reasonCode).toBe('BLOCKED_TOPIC');
    await expect(guardrail.evaluateInput(input('What is the weather in Paris?'))).resolves.toBeNull();
    expectOnlyTheEmbeddingWarning(log);
  });

  it('flags an off-topic input when only allowedTopics is given', async () => {
    const log = logger();
    const guardrail = guardrailOf(createExtensionPack({ options: { allowedTopics: ['billing'] }, logger: log } as any));

    const result = await guardrail.evaluateInput(input('Tell me about quantum physics'));

    expect(result).not.toBeNull();
    expect(result.action).toBe('flag');
    expect(result.reasonCode).toBe('OFF_TOPIC');
    await expect(guardrail.evaluateInput(input('I have a billing question'))).resolves.toBeNull();
    expectOnlyTheEmbeddingWarning(log);
  });
});
