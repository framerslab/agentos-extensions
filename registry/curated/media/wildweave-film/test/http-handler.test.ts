/**
 * The pack's `http-handler` descriptor: with `options.http.path` the pack adds one handler beside its 22 tools, of the
 * shape AgentOS's `HttpHandlerPayload` names, which a host's own `node:http` server calls for every request it does not
 * route itself. It answers its path alone, to callers on this machine alone, and serves the tools there to a streamable
 * HTTP client with the pack's key.
 */
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExtensionPack, HttpHandlerPayload } from '@framers/agentos';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HTTP_HANDLER_ID, createExtensionPack, type WildweaveFilmHttpHandlerDescriptor, type WildweaveFilmPack } from '../src/index.js';
import { isLoopbackPeer } from '../src/mcp/http.js';
import { TOOL_NAMES } from '../src/schemas.js';
import { FAKE_KEY, fixture, startFakeStudio, type FakeStudio } from './helpers.js';

// The payload is AgentOS's HttpHandlerPayload, and the pack with it still an ExtensionPack, checked at compile time.
type Assignable<T, U> = T extends U ? true : false;
const payloadIsHttpHandler: Assignable<WildweaveFilmHttpHandlerDescriptor['payload'], HttpHandlerPayload> = true;
const packIsExtensionPack: Assignable<WildweaveFilmPack, ExtensionPack> = true;

const PATH = '/mcp/wildweave-film';
const quiet = { write: () => undefined };

/** The pack's one http-handler descriptor; fails the test when it lists none or more than one. */
function httpHandlerOf(pack: WildweaveFilmPack): WildweaveFilmHttpHandlerDescriptor {
  const handlers = pack.descriptors.filter((d): d is WildweaveFilmHttpHandlerDescriptor => d.kind === 'http-handler');
  expect(handlers).toHaveLength(1);
  return handlers[0]!;
}

/** A host's server on the loopback address: each handler in turn, the first that answers wins, else the host's 404. */
async function startHost(handlers: HttpHandlerPayload[]): Promise<{ origin: string; port: number; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    // The host's own header on every answer, as wunderland sets it before its routes and handlers.
    res.setHeader('Access-Control-Allow-Origin', '*');
    for (const handle of handlers) {
      if (await handle(req, res)) return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** A raw MCP tools/list POST to the host, answered with its status. */
function post(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}

describe("the pack's http-handler descriptor", () => {
  it('is AgentOS\'s HttpHandlerPayload, in a pack that is still an ExtensionPack', () => {
    expect(payloadIsHttpHandler && packIsExtensionPack).toBe(true);
  });

  it('is not listed without the http option', async () => {
    const pack = await createExtensionPack({ options: {}, logDestination: quiet });
    expect(pack.descriptors.map((d) => d.kind)).toEqual(TOOL_NAMES.map(() => 'tool'));
  });

  it('is listed once beside the 22 tools with http.path, carrying its path', async () => {
    const pack = await createExtensionPack({ options: { http: { path: PATH } }, logDestination: quiet });
    expect(pack.descriptors.filter((d) => d.kind === 'tool').map((d) => d.id)).toEqual(TOOL_NAMES);
    const handler = httpHandlerOf(pack);
    expect(handler.id).toBe(HTTP_HANDLER_ID);
    expect(handler.id).toBe('wildweave_film_mcp_http');
    expect(handler.priority).toBe(30);
    expect(handler.metadata).toEqual({ path: PATH });
    expect(typeof handler.payload).toBe('function');
    await pack.onActivate();
    await pack.onDeactivate();
  });

  it.each([['mcp/wildweave-film'], ['/'], ['/mcp/'], ['/mcp//film'], ['/mcp/../admin'], ['/mcp?x=1'], ['/mcp film'], [''], [42]])('refuses the path %j', async (path) => {
    await expect(createExtensionPack({ options: { http: { path } }, logDestination: quiet })).rejects.toThrow(/http\.path/);
  });

  describe('mounted on a host', () => {
    let studio: FakeStudio;
    let pack: WildweaveFilmPack;
    let host: Awaited<ReturnType<typeof startHost>>;
    beforeEach(async () => {
      studio = await startFakeStudio();
      pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl, http: { path: PATH } }, logDestination: quiet });
      await pack.onActivate();
      host = await startHost([httpHandlerOf(pack).payload]);
    });
    afterEach(async () => {
      await host.close();
      await pack.onDeactivate();
      await studio.close();
    });

    it('serves the 22 tools at its path to a streamable HTTP client, with the key reaching the studio', async () => {
      const client = new Client({ name: 'wildweave-film-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${host.origin}${PATH}`)));
      try {
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? undefined : { cursor });
          names.push(...page.tools.map((t) => t.name));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        expect(names.sort()).toEqual([...TOOL_NAMES].sort());
        const result = await client.callTool({ name: 'wildweave_film_list', arguments: {} });
        const content = result.content as Array<{ type: string; text: string }>;
        expect(JSON.parse(content[0]!.text)).toMatchObject({ ok: true, result: fixture('films') });
        expect(studio.requests.at(-1)!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      } finally {
        await client.close();
      }
    });

    it('leaves any other path to the host', async () => {
      expect(await post(host.port, '/mcp')).toBe(404);
      expect(await post(host.port, `${PATH}/more`)).toBe(404);
      expect(await post(host.port, '/mcp/wildweave-filmx')).toBe(404);
      expect(studio.requests).toHaveLength(0);
    });

    it('refuses a request whose Host is not the loopback address, and one from a foreign origin', async () => {
      expect(await post(host.port, PATH, { host: 'evil.example' })).toBe(403);
      expect(await post(host.port, PATH, { host: `127.0.0.1:${host.port}`, origin: 'http://evil.example' })).toBe(403);
      expect(studio.requests).toHaveLength(0);
    });
  });

  it('refuses a peer outside the loopback with 403, before reading its request', async () => {
    const pack = await createExtensionPack({ options: { key: FAKE_KEY, http: { path: PATH } }, logDestination: quiet });
    const handle = httpHandlerOf(pack).payload;
    const answered: { status?: number; body?: string } = {};
    const res = {
      headersSent: false,
      setHeader: () => undefined,
      writeHead(status: number) {
        answered.status = status;
        return this;
      },
      end(body?: string) {
        answered.body = body;
        return this;
      },
    } as unknown as ServerResponse;
    const req = {
      method: 'POST',
      url: PATH,
      headers: { host: '127.0.0.1:3777', 'content-type': 'application/json' },
      socket: { remoteAddress: '203.0.113.7' },
      [Symbol.asyncIterator]: () => {
        throw new Error('the handler read the body of a refused request');
      },
    } as unknown as IncomingMessage;
    expect(await handle(req, res)).toBe(true);
    expect(answered.status).toBe(403);
    expect(answered.body).toContain('this machine');
    await pack.onDeactivate();
  });
});

describe('a failure after the answer began', () => {
  it('ends the answer as a failed stream, never writing a second body into it, and logs the stack', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const pack = await createExtensionPack({ options: { http: { path: PATH } }, logDestination: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) } });
    const handle = httpHandlerOf(pack).payload;
    const written: string[] = [];
    let destroyed = false;
    // A response whose headers went out already: the SDK adapter's writeHead throws, as Node's does then.
    const res = {
      headersSent: true,
      writableEnded: false,
      destroyed: false,
      setHeader: () => undefined,
      on() {
        return this;
      },
      writeHead() {
        throw Object.assign(new Error('Cannot write headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
      },
      write(chunk: unknown) {
        written.push(String(chunk));
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) written.push(String(chunk));
        return this;
      },
      destroy() {
        destroyed = true;
        return this;
      },
    } as unknown as ServerResponse;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wildweave-film-test', version: '1.0.0' } } });
    const req = {
      method: 'POST',
      url: PATH,
      headers: { host: '127.0.0.1:3777', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(Buffer.byteLength(body)) },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;
    expect(await handle(req, res)).toBe(true);
    expect(written).toEqual([]);
    expect(destroyed).toBe(true);
    const failure = lines.find((line) => line.event === 'wildweave_film.http_error');
    expect(failure?.reason).toContain('Cannot write headers');
    expect(failure?.stack).toEqual(expect.stringContaining('Cannot write headers'));
    await pack.onDeactivate();
  });
});

describe('isLoopbackPeer', () => {
  it.each([['127.0.0.1'], ['127.8.9.10'], ['::1'], ['::ffff:127.0.0.1'], ['::FFFF:127.0.0.2']])('takes %s', (address) => {
    expect(isLoopbackPeer(address)).toBe(true);
  });

  it.each([[undefined], [''], ['10.0.0.1'], ['128.0.0.1'], ['127.0.0.256'], ['::ffff:10.0.0.1'], ['::2'], ['fe80::1'], ['127.0.0.1.evil']])('refuses %s', (address) => {
    expect(isLoopbackPeer(address)).toBe(false);
  });
});
