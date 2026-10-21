#!/usr/bin/env node
/**
 * @fileoverview The parser as a process, the container's entry point. Its settings are environment variables:
 *
 * - `PARSER_SOCKET`: the socket's path. Default `/run/parser/parser.sock`.
 * - `PARSER_SPOOL`: the spool folder, which the host writes files into. Default `/run/parser/spool`.
 * - `PARSER_CONCURRENCY`: reads at once, from 1 to 64. Default 1.
 * - `PARSER_LOG_LEVEL`: the level of its lines, one of pino's (`fatal`, `error`, `warn`, `info`, `debug`, `trace`,
 *   `silent`). Default `info`.
 *
 * `agentos-document-parser health` is the container's healthcheck: it loads nothing but the socket, and exits 0 once
 * the socket accepts a connection and 1 when it does not within two seconds. The parser's lines are JSON on standard
 * output, through AgentOS's pino logger; SIGTERM and SIGINT stop it once its connections have closed.
 *
 * @module document-parser/bin
 */
import { createConnection } from 'node:net';

const socketPath = process.env.PARSER_SOCKET || '/run/parser/parser.sock';

/** Exits 0 once the socket accepts a connection, 1 when it refuses one or none opens within two seconds. */
function health(): void {
  const probe = createConnection(socketPath);
  probe.setTimeout(2_000, () => process.exit(1));
  probe.once('connect', () => {
    probe.end();
    process.exit(0);
  });
  probe.once('error', () => process.exit(1));
}

/** Starts the parser with its logger and stops it on SIGTERM or SIGINT; a start that fails writes one error line and exits 1. */
async function serve(): Promise<void> {
  // Loaded here rather than at the top: the healthcheck runs every few seconds and needs neither pino nor the readers.
  const { PinoLogger } = await import('@framers/agentos/logging');
  const { documentParserLogLevel } = await import('./log.js');
  const { startDocumentParser } = await import('./server.js');
  try {
    const concurrency = process.env.PARSER_CONCURRENCY;
    const parser = await startDocumentParser({
      socketPath,
      spool: process.env.PARSER_SPOOL || '/run/parser/spool',
      concurrency: concurrency === undefined || concurrency === '' ? undefined : Number(concurrency),
      logger: new PinoLogger({ name: 'document-parser', level: documentParserLogLevel(process.env.PARSER_LOG_LEVEL) }),
    });
    const stop = (): void => {
      void parser.stop().finally(() => process.exit(0));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch (error) {
    // At the error level whatever PARSER_LOG_LEVEL names: a start that fails is the one line an operator must see.
    // The reason is a setting's own words or the socket's error, never a file's.
    new PinoLogger({ name: 'document-parser', level: 'error' }).error('failed_to_start', {
      event: 'document_parser', state: 'failed_to_start', code: error instanceof Error ? error.message : 'error',
    });
    process.exit(1);
  }
}

if (process.argv[2] === 'health') health();
else await serve();
