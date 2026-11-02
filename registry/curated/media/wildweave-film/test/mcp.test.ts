import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/index.js';
import { createWildweaveMcpHandler, serveWildweaveHttp } from '../src/mcp/index.js';
import { TOOL_NAMES, toolJsonSchema } from '../src/schemas.js';
import { FAKE_KEY, FILM_ID, fixture, silentLog, startFakeStudio, type FakeStudio } from './helpers.js';

type ToolList = Awaited<ReturnType<Client['listTools']>>['tools'];

/** Every tool the server lists, across pages. */
async function allTools(client: Client): Promise<ToolList> {
  const tools: ToolList = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

/** The one text block a tool answers, parsed. */
function answerOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe('text');
  return JSON.parse(content[0]!.text!) as Record<string, unknown>;
}

/** A client of the in-process handler: the handler's fetch serves every request, no socket. */
async function inProcessClient(options: { key?: string; baseUrl?: string } = {}) {
  const config = await resolveConfig({ ...(options.key ? { key: options.key } : {}), baseUrl: options.baseUrl ?? 'https://studio.example.invalid' }, undefined, {});
  const handler = createWildweaveMcpHandler(config, silentLog);
  const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test.invalid/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'wildweave-film-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

describe('the MCP server', () => {
  let studio: FakeStudio;
  beforeEach(async () => {
    studio = await startFakeStudio();
  });
  afterEach(async () => {
    await studio.close();
  });

  it('lists the 22 tools, each with its draft-07 input schema as the pack defines it', async () => {
    const { client, close } = await inProcessClient();
    try {
      const tools = await allTools(client);
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      for (const tool of tools) {
        expect(tool.inputSchema).toEqual(toolJsonSchema(tool.name as (typeof TOOL_NAMES)[number]).input);
        expect(tool.description).toBeTruthy();
      }
      expect(tools.find((t) => t.name === 'wildweave_film_timeline')!.annotations?.readOnlyHint).toBe(true);
      expect(tools.find((t) => t.name === 'wildweave_film_edit')!.annotations?.readOnlyHint).toBe(false);
    } finally {
      await close();
    }
  });

  it('answers key_missing in one text block, flagged as an error, without a key', async () => {
    const { client, close } = await inProcessClient();
    try {
      const result = await client.callTool({ name: 'wildweave_film_list', arguments: {} });
      expect(result.isError).toBe(true);
      expect(answerOf(result)).toMatchObject({ ok: false, error: { code: 'key_missing' } });
    } finally {
      await close();
    }
  });

  it("answers the fake studio's film list, not flagged as an error", async () => {
    const { client, close } = await inProcessClient({ key: FAKE_KEY, baseUrl: studio.baseUrl });
    try {
      const result = await client.callTool({ name: 'wildweave_film_list', arguments: {} });
      expect(result.isError ?? false).toBe(false);
      expect(answerOf(result)).toMatchObject({ ok: true, result: fixture('films') });
    } finally {
      await close();
    }
  });

  it('refuses arguments its schema refuses before the tool runs, flagged as an error', async () => {
    const { client, close } = await inProcessClient({ key: FAKE_KEY, baseUrl: studio.baseUrl });
    try {
      const result = await client.callTool({
        name: 'wildweave_film_edit',
        arguments: { filmId: FILM_ID, editId: 'e1', ifUpdatedAtMs: { 'demo:timeline:film': 1 }, ops: [{ op: 'clip_window', sceneId: 's03', speed: 9 }] },
      });
      expect(result.isError).toBe(true);
      expect(studio.requests.some((r) => r.path.endsWith('/edits'))).toBe(false);
    } finally {
      await close();
    }
  });

  describe('over HTTP on the loopback address', () => {
    let served: Awaited<ReturnType<typeof serveWildweaveHttp>>;
    beforeEach(async () => {
      const config = await resolveConfig({ key: FAKE_KEY, baseUrl: studio.baseUrl }, undefined, {});
      served = await serveWildweaveHttp(config, silentLog, { host: '127.0.0.1', port: 0 });
    });
    afterEach(async () => {
      await served.close();
    });

    it('serves the tools to a client of the streamable HTTP transport', async () => {
      expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const client = new Client({ name: 'wildweave-film-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(served.url)));
      try {
        expect((await allTools(client)).map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
        expect(answerOf(await client.callTool({ name: 'wildweave_film_preview', arguments: { filmId: FILM_ID } }))).toMatchObject({ ok: true, result: { url: `/app/wildweave/${FILM_ID}` } });
      } finally {
        await client.close();
      }
    });

    /** A raw POST with the headers given, answered with its status. */
    function post(headers: Record<string, string>): Promise<number> {
      const { port } = new URL(served.url);
      return new Promise((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: Number(port), path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
      });
    }

    it('refuses a request whose Host is not the loopback address, and one from a foreign origin', async () => {
      expect(await post({ host: 'evil.example' })).toBe(403);
      expect(await post({ host: `127.0.0.1:${new URL(served.url).port}`, origin: 'http://evil.example' })).toBe(403);
    });

    it('refuses to bind any address but the loopback', async () => {
      const config = await resolveConfig({}, undefined, {});
      await expect(serveWildweaveHttp(config, silentLog, { host: '0.0.0.0' as '127.0.0.1', port: 0 })).rejects.toThrow(/loopback/);
    });
  });

  const bin = fileURLToPath(new URL('../bin/wildweave-film-mcp.mjs', import.meta.url));
  const built = existsSync(fileURLToPath(new URL('../dist/mcp/stdio.js', import.meta.url)));

  // The bin runs the built server; CI builds every pack before its tests. Without a build there is nothing to spawn.
  it.skipIf(!built)('serves the tools over stdio from the bin, with the key from the environment', async () => {
    const client = new Client({ name: 'wildweave-film-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [bin],
        env: { PATH: process.env.PATH ?? '', WILDWEAVE_STUDIO_KEY: FAKE_KEY, WILDWEAVE_STUDIO_BASE_URL: studio.baseUrl, WILDWEAVE_FILM_LOG_LEVEL: 'warn' },
        stderr: 'ignore',
      }),
    );
    try {
      expect((await allTools(client)).map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      const result = await client.callTool({ name: 'wildweave_film_list', arguments: {} });
      expect(answerOf(result)).toMatchObject({ ok: true, result: fixture('films') });
      expect(studio.requests.at(-1)!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    } finally {
      await client.close();
    }
  });
});
