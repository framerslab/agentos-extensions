/**
 * @module @framers/agentos-ext-wildweave-film/mcp/http
 *
 * The streamable HTTP entry. `createWildweaveMcpHandler` returns the SDK's web-standard handler
 * (`{ fetch, close }`), stateless: its factory makes one server a request. It reads no token from
 * a request's headers; a host that mounts `fetch` on its own route verifies its callers first and
 * may pass `authInfo` through. `serveWildweaveHttp` serves the same handler on `node:http`, bound
 * to the loopback address alone, behind the host and origin checks of `@modelcontextprotocol/node`
 * against DNS rebinding, at `/mcp`.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { createToolContext, resolveConfig, type PackConfig } from '../index.js';
import { createLogger, type Logger } from '../log.js';
import { createWildweaveMcpServer } from './server.js';

/** The handler: the SDK's `{ fetch, close }`, one server a request over one shared tool context. */
export function createWildweaveMcpHandler(config: PackConfig, log: Logger): McpHttpHandler {
  const ctx = createToolContext(config, log);
  return createMcpHandler(() => createWildweaveMcpServer(config, log, ctx), {
    onerror: (err) => log.warn({ event: 'wildweave_film.http_error', reason: err.message }, 'the MCP handler reported an error'),
  });
}

/** The addresses the HTTP entry binds: the loopback alone. */
export type LoopbackHost = '127.0.0.1' | '::1' | 'localhost';

const LOOPBACK = new Set<string>(['127.0.0.1', '::1', 'localhost']);

/** The path the HTTP entry serves the handler at. */
export const MCP_HTTP_PATH = '/mcp';

/** A running HTTP entry. */
export interface ServedHttp {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Serves the handler on `node:http` at `http://<host>:<port>/mcp`, the host a loopback address. */
export async function serveWildweaveHttp(config: PackConfig, log: Logger, options: { host?: LoopbackHost; port?: number } = {}): Promise<ServedHttp> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) throw new Error(`the HTTP entry binds a loopback address alone (127.0.0.1, ::1 or localhost), not ${host}`);
  const handler = createWildweaveMcpHandler(config, log);
  const serve = toNodeHandler(handler, { onerror: (err) => log.warn({ event: 'wildweave_film.http_error', reason: err.message }, 'the MCP handler reported an error') });
  const hostCheck = localhostHostValidation();
  const originCheck = localhostOriginValidation();
  const server = createServer((req, res) => {
    // Each check answers 403 itself when it refuses.
    if (!hostCheck(req, res) || !originCheck(req, res)) {
      log.info({ event: 'wildweave_film.refused', code: 'host_or_origin_refused' }, 'a request from outside the loopback was refused');
      return;
    }
    const path = new URL(req.url ?? '/', 'http://loopback.invalid').pathname;
    if (path !== MCP_HTTP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', path: MCP_HTTP_PATH }));
      return;
    }
    serve(req, res).catch((err: unknown) => {
      log.error({ event: 'wildweave_film.http_error', reason: err instanceof Error ? err.message : String(err) }, 'the MCP handler failed');
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}${MCP_HTTP_PATH}`;
  return {
    url,
    port,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await handler.close();
    },
  };
}

/**
 * The bin's `--http <host>:<port>`: the configuration from the environment, the logger on stderr,
 * then the HTTP entry until the process is stopped.
 */
export async function serveWildweaveHttpFromArgs(spec: string): Promise<ServedHttp> {
  const match = /^(?:\[(?<v6>[^\]]+)\]|(?<host>[^:]+)):(?<port>\d{1,5})$/.exec(spec.trim());
  const host = (match?.groups?.v6 ?? match?.groups?.host ?? '') as LoopbackHost;
  const port = Number(match?.groups?.port ?? NaN);
  if (!match || !LOOPBACK.has(host) || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--http takes <loopback host>:<port>, such as 127.0.0.1:8765; not ${JSON.stringify(spec)}`);
  }
  const config = await resolveConfig();
  const log = createLogger({ level: config.logLevel, secrets: config.key ? [config.key] : [] });
  const served = await serveWildweaveHttp(config, log, { host, port });
  log.info({ event: 'wildweave_film.http_started', url: served.url, remote: config.key !== undefined, local: config.engineDir !== undefined }, 'serving MCP over HTTP');
  return served;
}
