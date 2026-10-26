import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseRequest, parseAnswer, documentParserClient, PARSER_KINDS, PARSER_FAILURES, BOUND_CEILINGS, DEFAULT_BOUNDS,
} from '../src/index.js';

/** A fresh folder for one test's socket. */
const socketFolder = () => mkdtempSync(path.join(tmpdir(), 'parser-'));

describe('the parser protocol', () => {
  it('reads a request line and refuses a path outside the spool, an unknown kind and a bound over its ceiling', () => {
    const line = JSON.stringify({ id: 'a1', path: '/run/parser/spool/7f3a.pdf', kind: 'pdf', bounds: { maxBytes: 10_000_000, maxPages: 50, timeoutMs: 20_000 } });
    expect(parseRequest(line, '/run/parser/spool')).toEqual({ id: 'a1', path: '/run/parser/spool/7f3a.pdf', kind: 'pdf', bounds: { maxBytes: 10_000_000, maxPages: 50, timeoutMs: 20_000 } });
    expect(parseRequest(JSON.stringify({ id: 'a1', path: '/etc/passwd', kind: 'text', bounds: {} }), '/run/parser/spool')).toEqual({ id: 'a1', ok: false, failed: 'outside_spool' });
    expect(parseRequest(JSON.stringify({ id: 'a1', path: '/run/parser/spool/../x', kind: 'text', bounds: {} }), '/run/parser/spool')).toEqual({ id: 'a1', ok: false, failed: 'outside_spool' });
    expect(parseRequest(JSON.stringify({ id: 'a1', path: '/run/parser/spool/x', kind: 'exe', bounds: {} }), '/run/parser/spool')).toEqual({ id: 'a1', ok: false, failed: 'unsupported' });
    expect(parseRequest(JSON.stringify({ id: 'a1', path: '/run/parser/spool/x', kind: 'pdf', bounds: { timeoutMs: 120_001 } }), '/run/parser/spool')).toEqual({ id: 'a1', ok: false, failed: 'malformed' });
    expect(parseRequest(JSON.stringify({ id: 'a1', path: '/run/parser/spool/x', kind: 'text', bounds: { maxCharacters: 2_000_001 } }), '/run/parser/spool')).toEqual({ id: 'a1', ok: false, failed: 'malformed' });
    expect(parseRequest('not json', '/run/parser/spool')).toBeNull();
  });

  it('fails a call whose server accepts the connection and never answers, inside the read\'s time plus the grace', async () => {
    const socketPath = path.join(socketFolder(), 'mute.sock');
    const mute = createServer(() => { /* accepts and says nothing */ });
    await new Promise<void>((resolve) => mute.listen(socketPath, resolve));
    const client = documentParserClient(socketPath, 1_000, 200);
    await expect(client.parse(path.join(path.dirname(socketPath), 'spool', 'a.txt'), 'text', { timeoutMs: 100 })).rejects.toThrow('document_parser_answer_timeout');
    mute.close();
  });

  it('reads an answer whose characters arrive split across two writes', async () => {
    const socketPath = path.join(socketFolder(), 'split.sock');
    // Answers in two writes 50 ms apart, cut between the two bytes of the "é", so the client gets them as two chunks.
    const split = createServer((socket) => {
      socket.once('data', (chunk) => {
        const { id } = JSON.parse(String(chunk).trim()) as { id: string };
        const answer = Buffer.from(`${JSON.stringify({ id, ok: true, text: 'café crème', pages: null, truncated: false })}\n`, 'utf8');
        const cut = answer.indexOf(0xc3) + 1;
        socket.write(answer.subarray(0, cut));
        setTimeout(() => socket.end(answer.subarray(cut)), 50);
      });
    });
    await new Promise<void>((resolve) => split.listen(socketPath, resolve));
    const client = documentParserClient(socketPath, 1_000, 1_000);
    const answer = await client.parse(path.join(path.dirname(socketPath), 'spool', 'a.txt'), 'text', { timeoutMs: 1_000 });
    expect(answer).toMatchObject({ ok: true, text: 'café crème', pages: null, truncated: false });
    split.close();
  });

  it('names the kinds, the failures and the bounds once, for the clients that import them', () => {
    expect(PARSER_KINDS).toEqual(['pdf', 'docx', 'text', 'markdown']);
    expect(PARSER_FAILURES).toEqual(['too_large', 'too_long', 'scanned', 'encrypted', 'malformed', 'timeout', 'unsupported', 'outside_spool']);
    expect(DEFAULT_BOUNDS).toEqual({ maxBytes: 10_000_000, maxPages: 50, timeoutMs: 20_000, maxCharacters: 1_000_000 });
    expect(BOUND_CEILINGS).toEqual({ maxBytes: 50_000_000, maxPages: 500, timeoutMs: 120_000, maxCharacters: 2_000_000 });
    expect(parseAnswer(JSON.stringify({ id: 'a1', ok: true, text: 'hello', pages: 2, truncated: false }))).toEqual({ id: 'a1', ok: true, text: 'hello', pages: 2, truncated: false });
    expect(parseAnswer(JSON.stringify({ id: 'a1', ok: false, failed: 'scanned' }))).toEqual({ id: 'a1', ok: false, failed: 'scanned' });
    expect(parseAnswer(JSON.stringify({ id: 'a1', ok: true, text: 7 }))).toBeNull();
    expect(parseAnswer(JSON.stringify({ id: 'a1', ok: true, text: 'hello', pages: -1, truncated: false }))).toBeNull();
  });
});
