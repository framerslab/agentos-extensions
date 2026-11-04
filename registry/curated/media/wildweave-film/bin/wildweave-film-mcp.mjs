#!/usr/bin/env node
// The WildWeave film studio's MCP server: stdio by default (what Claude Code's .mcp.json runs), or
// `--http 127.0.0.1:<port>` for a host on this machine that speaks streamable HTTP (served at /mcp).
// Reads WILDWEAVE_STUDIO_KEY, WILDWEAVE_STUDIO_BASE_URL, WILDWEAVE_FILM_ENGINE_DIR, WILDWEAVE_FILM_REPO,
// WILDWEAVE_FILM_LOG_LEVEL and WILDWEAVE_FILM_TIMEOUT_MS from the environment and prints no value of them.
import { serveWildweaveHttpFromArgs } from '../dist/mcp/http.js';
import { serveWildweaveStdio } from '../dist/mcp/stdio.js';

const at = process.argv.indexOf('--http');
if (at !== -1) await serveWildweaveHttpFromArgs(process.argv[at + 1] ?? '127.0.0.1:0');
else await serveWildweaveStdio();
