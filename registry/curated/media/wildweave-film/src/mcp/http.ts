/**
 * @module @framers/agentos-ext-wildweave-film/mcp/http
 *
 * The streamable HTTP entry. `createWildweaveMcpHandler` returns the SDK's web-standard handler
 * (`{ fetch, close }`), stateless: its factory makes one server a request. It reads no token from
 * a request's headers; a host that mounts `fetch` on its own route verifies its callers first and
 * may pass `authInfo` through. `serveWildweaveHttp` serves the same handler on `node:http`, bound
 * to the loopback address alone, behind the host and origin checks of `@modelcontextprotocol/node`
 * against DNS rebinding, at `/mcp`. `createWildweaveMcpNodeHandler` is the same handler for a host's
 * own `node:http` server, at a path the host names: the payload of the pack's `http-handler`
 * descriptor.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { createToolContext, resolveConfig, type PackConfig } from '../index.js';
import { createLogger, type Logger } from '../log.js';
import type { ToolContext } from '../tools.js';
import { createWildweaveMcpServer } from './server.js';

/** The handler: the SDK's `{ fetch, close }`, one server a request over one shared tool context. */
export function createWildweaveMcpHandler(config: PackConfig, log: Logger): McpHttpHandler {
  const ctx = createToolContext(config, log);
  return createMcpHandler(() => createWildweaveMcpServer(config, log, ctx), {
    onerror: (err) => log.warn({ event: 'wildweave_film.http_error', reason: err.message }, 'the MCP handler reported an error'),
  });
}

/**
 * True for a peer address on the loopback: 127.0.0.0/8 and `::1`, each also in its IPv4-mapped IPv6
 * form (`::ffff:127.0.0.1`), as a dual-stack socket reports an IPv4 peer.
 */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (typeof address !== 'string' || address === '') return false;
  const lower = address.toLowerCase();
  const plain = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  if (plain === '::1') return true;
  return /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(plain);
}

/** A mount path: `/` then one or more segments of unreserved URL characters, none `.` or `..`, no trailing slash. */
const MOUNT_PATH = /^(?:\/[A-Za-z0-9\-._~]+)+$/;

/** The path a host mounts the handler at, checked; throws naming `http.path` for any other value. */
export function mountPath(path: unknown): string {
  if (typeof path !== 'string' || !MOUNT_PATH.test(path) || path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`http.path takes a path that begins with "/", such as "/mcp/wildweave-film", with no empty or dot segment, query or trailing slash; not ${JSON.stringify(path)}`);
  }
  return path;
}

/** A Node request handler as AgentOS's `HttpHandlerPayload` names it: true when it answered the request. */
export type WildweaveNodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** The MCP handler mounted at a path of a host's own server, and its close. */
export interface MountedWildweaveMcp {
  /** The path it answers. */
  path: string;
  /** The handler the host calls for each request it does not route itself. */
  handle: WildweaveNodeHandler;
  /** Ends the handler's open requests. */
  close(): Promise<void>;
}

/** A 403 in the JSON-RPC error form the SDK's own host and origin checks answer. */
function refuse(res: ServerResponse, message: string): void {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * The MCP handler for a host's own `node:http` server, at `path`. It answers `false` for any other
 * path (the query string aside), so the host's next handler answers. It serves callers on this
 * machine alone: a peer whose socket address is outside the loopback is answered 403 before its
 * body is read, then the SDK's Host and Origin checks answer 403 for a foreign Host (DNS rebinding)
 * or a foreign browser origin. A host bound to a network address so serves no other machine. The
 * rest goes to the SDK's web-standard handler through `toNodeHandler`, over `ctx` when given (the
 * pack's own tool context) or one made from `config`.
 */
export function createWildweaveMcpNodeHandler(config: PackConfig, log: Logger, path: string, ctx?: ToolContext): MountedWildweaveMcp {
  const at = mountPath(path);
  const shared = ctx ?? createToolContext(config, log);
  const onerror = (err: Error): void => log.warn({ event: 'wildweave_film.http_error', reason: err.message, stack: err.stack }, 'the MCP handler reported an error');
  const handler = createMcpHandler(() => createWildweaveMcpServer(config, log, shared), { onerror });
  const serve = toNodeHandler(handler, { onerror });
  const hostCheck = localhostHostValidation();
  const originCheck = localhostOriginValidation();
  const handle: WildweaveNodeHandler = async (req, res) => {
    const target = req.url ?? '';
    const query = target.indexOf('?');
    if ((query === -1 ? target : target.slice(0, query)) !== at) return false;
    if (!isLoopbackPeer(req.socket?.remoteAddress)) {
      log.info({ event: 'wildweave_film.refused', code: 'peer_not_loopback' }, 'a request from a peer outside the loopback was refused');
      refuse(res, "the studio's MCP endpoint answers callers on this machine alone");
      return true;
    }
    // Each check answers 403 itself when it refuses.
    if (!hostCheck(req, res) || !originCheck(req, res)) {
      log.info({ event: 'wildweave_film.refused', code: 'host_or_origin_refused' }, 'a request from outside the loopback was refused');
      return true;
    }
    try {
      await serve(req, res);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ event: 'wildweave_film.http_error', reason: error.message, stack: error.stack }, 'the MCP handler failed');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal' }));
      } else if (!res.writableEnded) {
        // The answer began (a stream, perhaps): a second body would corrupt it, so the connection ends it as failed.
        res.destroy();
      }
    }
    return true;
  };
  return { path: at, handle, close: () => handler.close() };
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
