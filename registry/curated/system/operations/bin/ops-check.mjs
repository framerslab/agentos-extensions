#!/usr/bin/env node
/**
 * The second machine's watcher, run once by a timer each minute:
 *
 *   ops-check <configuration file>
 *
 * The configuration file names the health address, the watch route, the state file's path and
 * the paths of the files holding the mail key and the check secret, which the command reads and
 * never prints. It exits 0 after its post and writes one line per run to stdout as a fixed word
 * with integers.
 */
import { runOpsCheck } from '../dist/check/index.js';

const code = await runOpsCheck(process.argv[2]);
process.exit(typeof code === 'number' ? code : 0);
