/**
 * @module @framers/agentos-ext-wildweave-film/mcp/stdio
 *
 * The stdio entry, what Claude Code's `.mcp.json` runs through the bin: the configuration from the
 * environment, the logger on stderr (stdout carries the protocol alone), and the SDK's `serveStdio`
 * over one server a connection.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createToolContext, resolveConfig } from '../index.js';
import { createLogger } from '../log.js';
import { createWildweaveMcpServer } from './server.js';

/** Serves the tools over this process's stdin and stdout until the client closes them. */
export async function serveWildweaveStdio(): Promise<{ close(): Promise<void> }> {
  const config = await resolveConfig();
  const log = createLogger({ level: config.logLevel, secrets: config.key ? [config.key] : [] });
  const ctx = createToolContext(config, log);
  const handle = serveStdio(() => createWildweaveMcpServer(config, log, ctx), {
    onerror: (err) => log.warn({ event: 'wildweave_film.stdio_error', reason: err.message }, 'the stdio entry reported an error'),
  });
  log.info({ event: 'wildweave_film.stdio_started', remote: config.key !== undefined, local: config.engineDir !== undefined }, 'serving MCP over stdio');
  return handle;
}
