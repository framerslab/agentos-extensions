// @ts-nocheck
/**
 * The guard as the AgentOS runtime runs it: chunks built with the runtime's own
 * `AgentOSResponseChunkType` values (`text_delta`, `final_response`) and fields
 * (`textDelta`, `finalResponseText`), passed through `wrapOutputGuardrails`, the
 * dispatcher every AgentOS output stream goes through.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentOSResponseChunkType, GuardrailAction, wrapOutputGuardrails } from '@framers/agentos';
import { ContentPolicyRewriterGuardrail } from '../src/ContentPolicyRewriterGuardrail.js';

const context = { userId: 'user-1', sessionId: 'session-1', personaId: 'persona-1' };
const base = { streamId: 'stream-1', gmiInstanceId: 'gmi-1', personaId: 'persona-1', timestamp: new Date(0).toISOString() };

function textDelta(text: string) {
  return { ...base, type: AgentOSResponseChunkType.TEXT_DELTA, isFinal: false, textDelta: text };
}

function finalResponse(text: string) {
  return { ...base, type: AgentOSResponseChunkType.FINAL_RESPONSE, isFinal: true, finalResponseText: text };
}

async function* streamOf(chunks: any[]) {
  for (const chunk of chunks) yield chunk;
}

async function collect(stream: AsyncGenerator<any>) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('ContentPolicyRewriterGuardrail under the AgentOS runtime', () => {
  it('uses the runtime chunk type values', () => {
    expect(AgentOSResponseChunkType.TEXT_DELTA).toBe('text_delta');
    expect(AgentOSResponseChunkType.FINAL_RESPONSE).toBe('final_response');
  });

  it('blocks a final response whose text holds a keyword of a blocked category', async () => {
    const llm = vi.fn();
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: llm,
      categories: { profanity: { enabled: true, action: 'block' } },
    });
    const result = await g.evaluateOutput({ context, chunk: finalResponse('What the fuck is this') });
    expect(result).not.toBeNull();
    expect(result.action).toBe(GuardrailAction.BLOCK);
    expect(result.reasonCode).toBe('KEYWORD_PROFANITY');
    expect(llm).not.toHaveBeenCalled();
  });

  it('judges and rewrites a final response in a sanitize category through the output dispatcher', async () => {
    const llm = vi.fn();
    llm.mockResolvedValueOnce('{ "violations": [{ "category": "profanity", "severity": "medium", "spans": ["damn"] }] }');
    llm.mockResolvedValueOnce('The person was very upset.');
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: llm,
      categories: { profanity: { enabled: true, action: 'sanitize' } },
    });

    const out = await collect(
      wrapOutputGuardrails(g, context, streamOf([textDelta('The person was '), finalResponse('The person was damn upset.')]), {
        streamId: 'stream-1',
      }),
    );

    expect(llm).toHaveBeenCalledTimes(2);
    const final = out.find((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final).toBeDefined();
    expect(final.finalResponseText).toBe('The person was very upset.');
  });

  it('ends the stream when a streamed delta holds a keyword of a blocked category', async () => {
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: vi.fn(),
      categories: { profanity: { enabled: true, action: 'block' } },
    });

    const out = await collect(
      wrapOutputGuardrails(g, context, streamOf([textDelta('What the fuck'), finalResponse('What the fuck')]), {
        streamId: 'stream-1',
      }),
    );

    expect(out.some((c) => c.type === AgentOSResponseChunkType.TEXT_DELTA)).toBe(false);
    expect(out.some((c) => c.type === AgentOSResponseChunkType.FINAL_RESPONSE)).toBe(false);
    const error = out.find((c) => c.type === AgentOSResponseChunkType.ERROR);
    expect(error).toBeDefined();
    expect(error.code).toBe('KEYWORD_PROFANITY');
  });

  it('replaces a streamed delta in a sanitize category', async () => {
    const llm = vi.fn().mockResolvedValue('{ "violations": [] }');
    const g = new ContentPolicyRewriterGuardrail({
      llmInvoker: llm,
      categories: { profanity: { enabled: true, action: 'sanitize' } },
    });

    const out = await collect(
      wrapOutputGuardrails(g, context, streamOf([textDelta('What the fuck'), finalResponse('Fine.')]), {
        streamId: 'stream-1',
      }),
    );

    const delta = out.find((c) => c.type === AgentOSResponseChunkType.TEXT_DELTA);
    expect(delta).toBeDefined();
    expect(delta.textDelta).toBe('[Content removed by policy]');
  });

  describe('decisions on the final response', () => {
    const judged = (violations: any[]) => JSON.stringify({ violations });

    it('blocks when one enabled violation is in a block category and another in a sanitize one', async () => {
      const llm = vi.fn().mockResolvedValueOnce(
        judged([
          { category: 'violence', severity: 'high', spans: ['a'] },
          { category: 'profanity', severity: 'low', spans: ['b'] },
        ]),
      );
      const g = new ContentPolicyRewriterGuardrail({
        llmInvoker: llm,
        keywordLists: { violence: [], profanity: [] },
        categories: { violence: { enabled: true, action: 'block' }, profanity: { enabled: true, action: 'sanitize' } },
      });
      const result = await g.evaluateOutput({ context, chunk: finalResponse('A plain reply.') });
      expect(result.action).toBe(GuardrailAction.BLOCK);
      expect(result.reasonCode).toBe('violence');
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('ignores a judged category that is unknown or not enabled', async () => {
      const llm = vi.fn().mockResolvedValueOnce(
        judged([
          { category: 'nonsense', severity: 'high', spans: ['a'] },
          { category: 'adult', severity: 'high', spans: ['b'] },
        ]),
      );
      const g = new ContentPolicyRewriterGuardrail({
        llmInvoker: llm,
        keywordLists: { profanity: [] },
        categories: { profanity: { enabled: true, action: 'sanitize' } },
      });
      const result = await g.evaluateOutput({ context, chunk: finalResponse('A plain reply.') });
      expect(result).toBeNull();
      expect(llm).toHaveBeenCalledTimes(1);
    });

    it('blocks at once on a block keyword even when a sanitize keyword comes first in the lists', async () => {
      const llm = vi.fn();
      const g = new ContentPolicyRewriterGuardrail({
        llmInvoker: llm,
        keywordLists: { profanity: ['heck'], illegal_harmful: ['zorbix'] },
        categories: { profanity: { enabled: true, action: 'sanitize' }, illegal_harmful: { enabled: true, action: 'block' } },
      });
      const result = await g.evaluateOutput({ context, chunk: finalResponse('heck, a zorbix here') });
      expect(result.action).toBe(GuardrailAction.BLOCK);
      expect(result.reasonCode).toBe('KEYWORD_ILLEGAL_HARMFUL');
      expect(llm).not.toHaveBeenCalled();
    });

    it('blocks when the judge call fails, and passes when the host chose judgeFailure allow', async () => {
      const options = {
        keywordLists: { profanity: [] },
        categories: { profanity: { enabled: true, action: 'sanitize' } },
      };
      const failing = new ContentPolicyRewriterGuardrail({ ...options, llmInvoker: vi.fn().mockRejectedValue(new Error('down')) });
      const blocked = await failing.evaluateOutput({ context, chunk: finalResponse('A plain reply.') });
      expect(blocked.action).toBe(GuardrailAction.BLOCK);
      expect(blocked.reasonCode).toBe('JUDGE_FAILED');

      const malformed = new ContentPolicyRewriterGuardrail({ ...options, llmInvoker: vi.fn().mockResolvedValue('not json') });
      const blockedToo = await malformed.evaluateOutput({ context, chunk: finalResponse('A plain reply.') });
      expect(blockedToo.reasonCode).toBe('JUDGE_FAILED');

      const allowing = new ContentPolicyRewriterGuardrail({
        ...options,
        judgeFailure: 'allow',
        llmInvoker: vi.fn().mockRejectedValue(new Error('down')),
      });
      expect(await allowing.evaluateOutput({ context, chunk: finalResponse('A plain reply.') })).toBeNull();
    });

    it('blocks when the rewrite fails or comes back empty, never passing the original as a rewrite', async () => {
      const options = {
        keywordLists: { profanity: [] },
        categories: { profanity: { enabled: true, action: 'sanitize' } },
      };
      const violation = judged([{ category: 'profanity', severity: 'low', spans: ['x'] }]);

      const rejected = vi.fn().mockResolvedValueOnce(violation).mockRejectedValueOnce(new Error('down'));
      const r1 = await new ContentPolicyRewriterGuardrail({ ...options, llmInvoker: rejected }).evaluateOutput({
        context,
        chunk: finalResponse('A plain reply.'),
      });
      expect(r1.action).toBe(GuardrailAction.BLOCK);
      expect(r1.reasonCode).toBe('REWRITE_FAILED');
      expect(r1.modifiedText).toBeUndefined();

      const empty = vi.fn().mockResolvedValueOnce(violation).mockResolvedValueOnce('   ');
      const r2 = await new ContentPolicyRewriterGuardrail({ ...options, llmInvoker: empty }).evaluateOutput({
        context,
        chunk: finalResponse('A plain reply.'),
      });
      expect(r2.action).toBe(GuardrailAction.BLOCK);
      expect(r2.reasonCode).toBe('REWRITE_FAILED');
    });

    it('rewrites a judged violation that carries no spans', async () => {
      const llm = vi
        .fn()
        .mockResolvedValueOnce(judged([{ category: 'profanity' }]))
        .mockResolvedValueOnce('A cleaner reply.');
      const g = new ContentPolicyRewriterGuardrail({
        llmInvoker: llm,
        keywordLists: { profanity: [] },
        categories: { profanity: { enabled: true, action: 'sanitize' } },
      });
      const result = await g.evaluateOutput({ context, chunk: finalResponse('A plain reply.') });
      expect(result.action).toBe(GuardrailAction.SANITIZE);
      expect(result.modifiedText).toBe('A cleaner reply.');
    });
  });

  describe('decisions on streamed deltas', () => {
    it('catches a phrase split across two deltas', async () => {
      const g = new ContentPolicyRewriterGuardrail({
        llmInvoker: vi.fn(),
        keywordLists: { illegal_harmful: ['zorbix plan'] },
        categories: { illegal_harmful: { enabled: true, action: 'block' } },
      });

      const out = await collect(
        wrapOutputGuardrails(g, context, streamOf([textDelta('the zorbix '), textDelta('plan is'), finalResponse('x')]), {
          streamId: 'stream-1',
        }),
      );

      expect(out.filter((c) => c.type === AgentOSResponseChunkType.TEXT_DELTA).map((c) => c.textDelta)).toEqual(['the zorbix ']);
      const error = out.find((c) => c.type === AgentOSResponseChunkType.ERROR);
      expect(error.code).toBe('KEYWORD_ILLEGAL_HARMFUL');
    });

    it('does not judge a keyword again once the delta that held it was replaced', async () => {
      const g = new ContentPolicyRewriterGuardrail({
        llmInvoker: vi.fn(),
        keywordLists: { profanity: ['heck'] },
        categories: { profanity: { enabled: true, action: 'sanitize' } },
      });
      const first = await g.evaluateOutput({ context, chunk: textDelta('oh heck ') });
      expect(first.action).toBe(GuardrailAction.SANITIZE);
      expect(await g.evaluateOutput({ context, chunk: textDelta('fine now') })).toBeNull();
    });

    it('keeps the streams apart', async () => {
      const g = new ContentPolicyRewriterGuardrail({
        llmInvoker: vi.fn(),
        keywordLists: { illegal_harmful: ['zorbix plan'] },
        categories: { illegal_harmful: { enabled: true, action: 'block' } },
      });
      expect(await g.evaluateOutput({ context, chunk: { ...textDelta('the zorbix '), streamId: 'a' } })).toBeNull();
      expect(await g.evaluateOutput({ context, chunk: { ...textDelta('plan is'), streamId: 'b' } })).toBeNull();
    });

    it('skips deltas on a direct call when streamingPreFilter is false', async () => {
      const g = new ContentPolicyRewriterGuardrail({
        llmInvoker: vi.fn(),
        streamingPreFilter: false,
        categories: { profanity: { enabled: true, action: 'block' } },
      });
      expect(await g.evaluateOutput({ context, chunk: textDelta('What the fuck') })).toBeNull();
      const final = await g.evaluateOutput({ context, chunk: finalResponse('What the fuck') });
      expect(final.action).toBe(GuardrailAction.BLOCK);
    });
  });
});

