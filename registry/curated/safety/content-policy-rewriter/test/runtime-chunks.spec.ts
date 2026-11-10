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
});
