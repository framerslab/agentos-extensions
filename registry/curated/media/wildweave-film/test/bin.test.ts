/**
 * End to end over the real path: the bin as a host runs it, a separate Node process, driven by the
 * SDK's MCP client. Over stdio without a key it answers key_missing and engine_missing; with a key at
 * the debug level, stdout carries the protocol alone and every log line goes to stderr as JSON, the key
 * in none. With `--http` it serves the same tools on the loopback address and refuses any other. The
 * loopback HTTP entry refuses a call without a studio key and calls no studio.
 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../src/index.js';
import { serveWildweaveHttp } from '../src/mcp/index.js';
import { TOOL_NAMES } from '../src/schemas.js';
import { FAKE_KEY, FILM_ID, SAMPLE_ARGS, fixture, silentLog, startFakeStudio, type FakeStudio } from './helpers.js';

const bin = fileURLToPath(new URL('../bin/wildweave-film-mcp.mjs', import.meta.url));

/** The one text block a tool answers, parsed. */
function answerOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  return JSON.parse(content[0]!.text ?? '') as Record<string, unknown>;
}

/** Every tool the server lists, across pages. */
async function toolNames(client: Client): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    names.push(...page.tools.map((t) => t.name));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return names.sort();
}

/** The JSON lines a process wrote, parsed; a line that is not JSON fails the test, besides Node's own warnings. */
function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('(node:'))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`a line that is not a JSON log line: ${line}`);
      }
    });
}

let studio: FakeStudio;
beforeEach(async () => {
  studio = await startFakeStudio();
});
afterEach(async () => {
  await studio.close();
});

/** The bin over stdio, its stderr kept. */
async function stdioBin(env: Record<string, string>) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin], env: { PATH: process.env.PATH ?? '', ...env }, stderr: 'pipe' });
  const chunks: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
  const client = new Client({ name: 'wildweave-film-bin', version: '1.0.0' });
  const errors: Error[] = [];
  client.onerror = (err) => void errors.push(err);
  await client.connect(transport);
  return { client, errors, stderr: () => chunks.join('') };
}

describe('the bin', () => {
  it('answers key_missing and engine_missing over stdio when neither is configured, and calls no studio', async () => {
    const { client, errors, stderr } = await stdioBin({ WILDWEAVE_STUDIO_BASE_URL: studio.baseUrl });
    try {
      expect(await toolNames(client)).toEqual([...TOOL_NAMES].sort());
      const remote = await client.callTool({ name: 'wildweave_film_timeline', arguments: { filmId: FILM_ID } });
      expect(remote.isError).toBe(true);
      expect(answerOf(remote)).toMatchObject({ ok: false, error: { code: 'key_missing' } });
      const local = await client.callTool({ name: 'wildweave_film_cut', arguments: SAMPLE_ARGS.wildweave_film_cut });
      expect(local.isError).toBe(true);
      expect(answerOf(local)).toMatchObject({ ok: false, error: { code: 'engine_missing' } });
      await vi.waitFor(() => expect(stderr()).toContain('"tool":"wildweave_film_cut"'), { timeout: 10_000 });
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
    expect(studio.requests).toHaveLength(0);
  });

  it('keeps stdout for the protocol: at debug, every log line goes to stderr as JSON, and the key is in none', async () => {
    const { client, errors, stderr } = await stdioBin({ WILDWEAVE_STUDIO_KEY: FAKE_KEY, WILDWEAVE_STUDIO_BASE_URL: studio.baseUrl, WILDWEAVE_FILM_LOG_LEVEL: 'debug' });
    try {
      expect(answerOf(await client.callTool({ name: 'wildweave_film_list', arguments: {} }))).toMatchObject({ ok: true, result: fixture('films') });
      // A route's refusal writes its own line besides the call's.
      expect(answerOf(await client.callTool({ name: 'wildweave_film_timeline', arguments: { filmId: 'film-unknown' } }))).toMatchObject({ ok: false, error: { code: 'not_found' } });
      await vi.waitFor(() => expect(stderr()).toContain('"tool":"wildweave_film_timeline"'), { timeout: 10_000 });
      // A line on stdout that is not the protocol would reach the client as an error.
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
    const lines = jsonLines(stderr());
    expect(lines.every((line) => line.module === 'wildweave-film-mcp')).toBe(true);
    const events = lines.map((line) => line.event);
    expect(events).toContain('wildweave_film.stdio_started');
    expect(events).toContain('wildweave_film.refused');
    expect(events.filter((e) => e === 'wildweave_film.call')).toHaveLength(2);
    expect(stderr()).not.toContain(FAKE_KEY);
    expect(studio.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${FAKE_KEY}`, `Bearer ${FAKE_KEY}`]);
  });

  it('serves the tools over HTTP on the loopback address with --http, and refuses any other address', async () => {
    const env = { PATH: process.env.PATH ?? '', WILDWEAVE_STUDIO_KEY: FAKE_KEY, WILDWEAVE_STUDIO_BASE_URL: studio.baseUrl };
    const child = spawn(process.execPath, [bin, '--http', '127.0.0.1:0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    try {
      // The bin names the address it bound in its start line, on stderr.
      let url = '';
      await vi.waitFor(
        () => {
          const started = jsonLines(stderr).find((line) => line.event === 'wildweave_film.http_started');
          expect(started, stderr).toBeDefined();
          url = String(started!.url);
        },
        { timeout: 15_000, interval: 100 },
      );
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const client = new Client({ name: 'wildweave-film-bin', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      try {
        expect(await toolNames(client)).toEqual([...TOOL_NAMES].sort());
        expect(answerOf(await client.callTool({ name: 'wildweave_film_list', arguments: {} }))).toMatchObject({ ok: true, result: fixture('films') });
      } finally {
        await client.close();
      }
      expect(studio.requests.at(-1)!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(stderr).not.toContain(FAKE_KEY);
    } finally {
      child.kill();
      await exited;
    }

    const refused = spawnSync(process.execPath, [bin, '--http', '0.0.0.0:0'], { env, encoding: 'utf8', timeout: 15_000 });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('loopback');
    expect(refused.stdout).toBe('');
  });
});

describe('the loopback HTTP entry without a studio key', () => {
  it('answers key_missing, flagged as an error, and calls no studio', async () => {
    const config = await resolveConfig({ baseUrl: studio.baseUrl }, undefined, {});
    const served = await serveWildweaveHttp(config, silentLog, { host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'wildweave-film-bin', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(served.url)));
      for (const name of ['wildweave_film_list', 'wildweave_film_edit', 'wildweave_film_proposal_decide'] as const) {
        const result = await client.callTool({ name, arguments: SAMPLE_ARGS[name] });
        expect(result.isError, name).toBe(true);
        expect(answerOf(result), name).toMatchObject({ ok: false, error: { code: 'key_missing' } });
      }
    } finally {
      await client.close();
      await served.close();
    }
    expect(studio.requests).toHaveLength(0);
  });
});
