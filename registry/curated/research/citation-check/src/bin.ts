#!/usr/bin/env node
/**
 * @file bin.ts
 * @description The `agentos-citations` executable: runs the command with the process's arguments, input, output and
 * environment, and exits with its status.
 *
 * @module agentos/extensions/research/citation-check/bin
 */

import { runCitationCli } from './cli.js';

process.exitCode = await runCitationCli(process.argv.slice(2));
