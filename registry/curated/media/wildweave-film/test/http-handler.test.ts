/**
 * The pack's `http-handler` descriptor: with `options.http` the pack adds one handler beside its 23 tools, of the
 * shape AgentOS's `HttpHandlerPayload` names, which a host's own `node:http` server calls for every request it does not
 * route itself. It answers its path alone, to a caller on this machine that sends `Authorization: Bearer <http token>`,
 * and serves the tools there to a streamable HTTP client with the pack's key. A same-host reverse proxy makes a remote
 * caller look local (a loopback peer, a loopback Host, no Origin), so the token is what refuses it.
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
/** The endpoint's bearer token: 64 hex characters, as `openssl rand -hex 32` writes one. */
const TOKEN = 'a1'.repeat(32);
const BEARER = `Bearer ${TOKEN}`;
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

/** The tools a streamable HTTP client lists at `url`, sending `headers` on every request. */
async function listToolNames(url: string, headers: Record<string, string>): Promise<string[]> {
  const client = new Client({ name: 'wildweave-film-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  try {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return names.sort();
  } finally {
    await client.close();
  }
}

/**
 * A reverse proxy on the loopback in front of the host, as nginx's `proxy_pass http://127.0.0.1:<port>` with its default
 * `proxy_set_header Host $proxy_host` forwards a request: the Host rewritten to the upstream's address and port, every
 * other header passed on, and the connection to the host opened from the loopback. Whoever reaches the proxy, a remote
 * caller included, reaches the host as a loopback peer with a loopback Host and no Origin.
 */
async function startSameHostProxy(upstreamPort: number): Promise<{ origin: string; port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const upstream = request(
      { host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}`, connection: 'close' } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
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

  it('is listed once beside the 23 tools with http.path and http.token, carrying its path', async () => {
    const pack = await createExtensionPack({ options: { http: { path: PATH, token: TOKEN } }, logDestination: quiet });
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
    await expect(createExtensionPack({ options: { http: { path, token: TOKEN } }, logDestination: quiet })).rejects.toThrow(/http\.path/);
  });

  describe('mounted on a host', () => {
    let studio: FakeStudio;
    let pack: WildweaveFilmPack;
    let host: Awaited<ReturnType<typeof startHost>>;
    beforeEach(async () => {
      studio = await startFakeStudio();
      pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl, http: { path: PATH, token: TOKEN } }, logDestination: quiet });
      await pack.onActivate();
      host = await startHost([httpHandlerOf(pack).payload]);
    });
    afterEach(async () => {
      await host.close();
      await pack.onDeactivate();
      await studio.close();
    });

    it('serves the 23 tools at its path to a streamable HTTP client, with the key reaching the studio', async () => {
      const client = new Client({ name: 'wildweave-film-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${host.origin}${PATH}`), { requestInit: { headers: { authorization: BEARER } } }));
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
    const pack = await createExtensionPack({ options: { key: FAKE_KEY, http: { path: PATH, token: TOKEN } }, logDestination: quiet });
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
    const pack = await createExtensionPack({ options: { http: { path: PATH, token: TOKEN } }, logDestination: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) } });
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
      headers: { host: '127.0.0.1:3777', authorization: BEARER, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(Buffer.byteLength(body)) },
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

describe("the endpoint's bearer token", () => {
  it.each([
    ['no token', { path: PATH }],
    ['an empty token', { path: PATH, token: '' }],
    ['a blank token', { path: PATH, token: '   ' }],
    ['a token that is not a string', { path: PATH, token: 42 }],
    ['a token shorter than 32 characters', { path: PATH, token: 'a1'.repeat(15) }],
    ['a token with a space inside', { path: PATH, token: `${'a1'.repeat(16)} ${'a1'.repeat(16)}` }],
  ])('refuses to load the pack with %s, naming http.token, rather than serve an open endpoint', async (_label, http) => {
    await expect(createExtensionPack({ options: { key: FAKE_KEY, http }, logDestination: quiet })).rejects.toThrow(/http\.token/);
  });

  it('reads the token from the secret wildweave.studio.http_token when the option has none, and lists that secret', async () => {
    const asked: string[] = [];
    const pack = await createExtensionPack({
      options: { key: FAKE_KEY, http: { path: PATH } },
      getSecret: (id) => {
        asked.push(id);
        return id === 'wildweave.studio.http_token' ? TOKEN : undefined;
      },
      logDestination: quiet,
    });
    expect(asked).toContain('wildweave.studio.http_token');
    const handler = httpHandlerOf(pack);
    expect(handler.requiredSecrets?.map((s) => s.id)).toContain('wildweave.studio.http_token');
    const host = await startHost([handler.payload]);
    try {
      expect(await post(host.port, PATH)).toBe(401);
      expect(await listToolNames(`${host.origin}${PATH}`, { authorization: BEARER })).toEqual([...TOOL_NAMES].sort());
    } finally {
      await host.close();
      await pack.onDeactivate();
    }
  });

  describe('behind a reverse proxy on the same host', () => {
    let studio: FakeStudio;
    let pack: WildweaveFilmPack;
    let host: Awaited<ReturnType<typeof startHost>>;
    let proxy: Awaited<ReturnType<typeof startSameHostProxy>>;
    const lines: string[] = [];
    beforeEach(async () => {
      lines.length = 0;
      studio = await startFakeStudio();
      pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl, http: { path: PATH, token: TOKEN } }, logDestination: { write: (line: string) => void lines.push(line) } });
      await pack.onActivate();
      host = await startHost([httpHandlerOf(pack).payload]);
      proxy = await startSameHostProxy(host.port);
    });
    afterEach(async () => {
      await proxy.close();
      await host.close();
      await pack.onDeactivate();
      await studio.close();
    });

    it('answers 401 to a forwarded request with no token, and serves no tool', async () => {
      expect(await post(proxy.port, PATH)).toBe(401);
      await expect(listToolNames(`${proxy.origin}${PATH}`, {})).rejects.toThrow();
      expect(studio.requests).toHaveLength(0);
    });

    it('answers 401 to a wrong token, a token in another scheme and a bare token', async () => {
      expect(await post(proxy.port, PATH, { authorization: `Bearer ${'b2'.repeat(32)}` })).toBe(401);
      expect(await post(proxy.port, PATH, { authorization: `Bearer ${TOKEN}x` })).toBe(401);
      expect(await post(proxy.port, PATH, { authorization: `Basic ${Buffer.from(`user:${TOKEN}`).toString('base64')}` })).toBe(401);
      expect(await post(proxy.port, PATH, { authorization: TOKEN })).toBe(401);
      expect(studio.requests).toHaveLength(0);
    });

    it('serves the 23 tools to a caller with the token, the key reaching the studio, and logs neither the token nor the key', async () => {
      expect(await listToolNames(`${proxy.origin}${PATH}`, { authorization: BEARER })).toEqual([...TOOL_NAMES].sort());
      const client = new Client({ name: 'wildweave-film-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${proxy.origin}${PATH}`), { requestInit: { headers: { authorization: `bearer ${TOKEN}` } } }));
      try {
        const result = await client.callTool({ name: 'wildweave_film_list', arguments: {} });
        const content = result.content as Array<{ type: string; text: string }>;
        expect(JSON.parse(content[0]!.text)).toMatchObject({ ok: true, result: fixture('films') });
        expect(studio.requests.at(-1)!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      } finally {
        await client.close();
      }
      expect(await post(proxy.port, PATH)).toBe(401);
      expect(lines.join('\n')).not.toContain(TOKEN);
      expect(lines.join('\n')).not.toContain(FAKE_KEY);
      expect(lines.some((line) => line.includes('"code":"token_missing"'))).toBe(true);
    });
  });

  it('answers 401 with a Bearer challenge to a loopback caller with no token, before reading its request', async () => {
    const pack = await createExtensionPack({ options: { key: FAKE_KEY, http: { path: PATH, token: TOKEN } }, logDestination: quiet });
    const handle = httpHandlerOf(pack).payload;
    const answered: { status?: number; headers?: Record<string, string>; body?: string } = {};
    const res = {
      headersSent: false,
      setHeader: () => undefined,
      writeHead(status: number, headers?: Record<string, string>) {
        answered.status = status;
        answered.headers = headers;
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
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: () => {
        throw new Error('the handler read the body of a refused request');
      },
    } as unknown as IncomingMessage;
    expect(await handle(req, res)).toBe(true);
    expect(answered.status).toBe(401);
    expect(answered.headers?.['www-authenticate']).toMatch(/^Bearer/);
    expect(answered.body).not.toContain(TOKEN);
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
