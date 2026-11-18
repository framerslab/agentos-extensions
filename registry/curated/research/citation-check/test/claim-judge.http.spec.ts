import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimJudge, claimJudgePrompt, claimJudgeSystem } from '../src/index';

// claimJudge over AgentOS's own generateObject and its OpenAI provider, against a stand-in for OpenAI's API on the
// loopback address that this file starts: the request it sends and the judgement and tokens it reads back, one request
// when the answer is an error (one attempt, no retry), the call ended at its deadline when the body stalls, and the
// caller's abort.

const KEY = 'sk-standin-claim-judge';
const MODEL = 'gpt-6-luna';

type Mode = 'answer' | 'fail' | 'stall';

interface Chat {
  body: { model?: string; messages?: Array<{ role: string; content: unknown }> };
  closedEarly: boolean;
}

let server: Server;
let origin = '';
let mode: Mode = 'answer';
const chats: Chat[] = [];

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => {
      text += chunk;
    });
    request.on('end', () => resolve(text));
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const text = await bodyOf(request);
  if (request.headers.authorization !== `Bearer ${KEY}`) return send(response, 401, { error: { message: 'bad key', type: 'invalid_request_error' } });
  if (request.method === 'GET' && path === '/v1/models') return send(response, 200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
  if (request.method !== 'POST' || path !== '/v1/chat/completions') return send(response, 404, { error: { message: 'unknown route', type: 'invalid_request_error' } });
  const chat: Chat = { body: text === '' ? {} : (JSON.parse(text) as Chat['body']), closedEarly: false };
  chats.push(chat);
  response.on('close', () => {
    if (!response.writableEnded) chat.closedEarly = true;
  });
  if (mode === 'fail') return send(response, 500, { error: { message: 'the server failed', type: 'server_error' } });
  if (mode === 'stall') {
    // The headers and a first part of the body, then nothing more.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"id":"chatcmpl-standin","object":"chat.completion",');
    return;
  }
  send(response, 200, {
    id: 'chatcmpl-standin',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: MODEL,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify({ relation: 'differs', quote: 'signed on 28 June 1919' }), refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 321, completion_tokens: 17, total_tokens: 338 },
  });
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  chats.length = 0;
  mode = 'answer';
});

const SYSTEM = claimJudgeSystem('encyclopedia');
const PROMPT = claimJudgePrompt(
  'The Treaty of Versailles was signed in 1918.',
  'The Treaty of Versailles was signed in 1918.',
  'Treaty of Versailles',
  'The Treaty of Versailles was a peace treaty signed on 28 June 1919.',
);

function judge(deadlineMs: number) {
  return claimJudge({ model: `openai:${MODEL}`, apiKey: KEY, baseUrl: `${origin}/v1`, deadlineMs, maxOutputTokens: 300 });
}

/** The text of a chat message's content, whether a string or a list of parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '')).join('');
  return '';
}

describe('claimJudge on AgentOS generateObject, against a stand-in for the model', () => {
  it('sends the instruction and the prompt to the model named, and answers its judgement with its tokens', async () => {
    const answer = await judge(5_000)({ system: SYSTEM, prompt: PROMPT, signal: new AbortController().signal });
    expect(answer).toEqual({ value: { relation: 'differs', quote: 'signed on 28 June 1919' }, usage: { in: 321, out: 17 } });
    expect(chats).toHaveLength(1);
    const messages = chats[0]?.body.messages ?? [];
    expect(chats[0]?.body.model).toBe(MODEL);
    expect(messages.filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n')).toContain(SYSTEM.split('\n')[0]);
    expect(messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')).toContain(PROMPT);
  });

  it('sends one request when the model answers 500, and rejects', async () => {
    mode = 'fail';
    await expect(judge(5_000)({ system: SYSTEM, prompt: PROMPT, signal: new AbortController().signal })).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(chats).toHaveLength(1);
  });

  it('ends at its deadline when the body stalls, and the request is closed', async () => {
    mode = 'stall';
    const started = Date.now();
    await expect(judge(500)({ system: SYSTEM, prompt: PROMPT, signal: new AbortController().signal })).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_500);
    await vi.waitFor(() => expect(chats[0]?.closedEarly).toBe(true), { timeout: 2_000 });
    expect(chats).toHaveLength(1);
  });

  it("rejects with the caller's reason when the caller aborts while the body stalls", async () => {
    mode = 'stall';
    const controller = new AbortController();
    const pending = judge(5_000)({ system: SYSTEM, prompt: PROMPT, signal: controller.signal });
    await vi.waitFor(() => expect(chats).toHaveLength(1), { timeout: 2_000 });
    const reason = new Error('the check stopped');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
