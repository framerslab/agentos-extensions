/**
 * @module @framers/agentos-ext-wildweave-film/mcp
 *
 * The MCP entries: the server, the streamable HTTP handler and its loopback server, and the stdio
 * entry the bin runs.
 */
export { MCP_SERVER_NAME, createWildweaveMcpServer } from './server.js';
export { MCP_HTTP_PATH, createWildweaveMcpHandler, serveWildweaveHttp, serveWildweaveHttpFromArgs, type LoopbackHost, type ServedHttp } from './http.js';
export { serveWildweaveStdio } from './stdio.js';
