/**
 * @file cli.ts
 * @description The `agentos-citations` command: `verify <file>` checks a document's cited claims and prints the
 * markdown log, or the report as JSON with `--json`; its exit status is 0 when the check passes, 1 when it fails and 2
 * for a usage or input error. `--embeddings openai` grades the claims not found word for word with OpenAI embeddings
 * through AgentOS, with `OPENAI_API_KEY` (and `OPENAI_BASE_URL` when set) from the environment.
 *
 * @module agentos/extensions/research/citation-check/cli
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { openAIEmbeddings } from './embeddings.js';
import { CitationInputError, type CitedClaimFormat } from './parse.js';
import { citationReportFails, renderCitationLog } from './report.js';
import { checkCitationDocument, CitationSetupError, type CitationCheckOptions } from './runner.js';
import type { CitationReport } from './types.js';

/** The command's help. */
export const CITATION_CLI_USAGE = `Usage: agentos-citations verify <file> [options]

Checks each quoted claim in <file> against the page its address names, and prints the
markdown for a "Citation check log" section. <file> is markdown, in which each quotation
is followed by its address ("the quoted words" (https://example.org/page)), or a JSON
array of {"claim", "url", "exact"}; - reads standard input.

Options:
  --json                print the report as JSON instead of the markdown log
  --embeddings <name>   none (the default) or openai: grade the claims not found word for
                        word with OpenAI embeddings through AgentOS (OPENAI_API_KEY, and
                        OPENAI_BASE_URL when set)
  --format <format>     auto (the default), markdown or json
  --allow-unreachable   do not fail on a page that could not be fetched or read
  --no-fallback         do not retry a failed page through the web scraper's tiers
  --timeout <ms>        the deadline for each page, in milliseconds (default 15000)
  -h, --help            print this help

Exit status: 0 when every claim passes; 1 when a claim is contradicted, not found or
unverifiable, or its page unreachable or unreadable; 2 for a usage or input error.`;

/** Where the command reads and writes, which a test or a host replaces. */
export interface CitationCliIO {
  /** Standard output; the process's when left out. */
  stdout?: (text: string) => void;
  /** Standard error; the process's when left out. */
  stderr?: (text: string) => void;
  /** The environment the keys are read from; the process's when left out. */
  env?: Record<string, string | undefined>;
  /** Reads a file; `fs.readFile` as UTF-8 when left out. */
  readFile?: (path: string) => Promise<string>;
  /** Reads standard input; the process's when left out. */
  readStdin?: () => Promise<string>;
  /** Options the check starts from; the command's own flags override them. */
  options?: CitationCheckOptions;
}

/** The process's standard input, read to its end as UTF-8. */
async function processStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** An error's message, its first line. */
function messageOf(error: unknown): string {
  return ((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '').trim();
}

/**
 * Runs the command.
 *
 * @param argv - The arguments after the command's name.
 * @param io - Where it reads and writes.
 * @returns The exit status: 0 when the check passes, 1 when it fails, 2 for a usage or input error.
 */
export async function runCitationCli(argv: readonly string[], io: CitationCliIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const env = io.env ?? process.env;
  const usage = (problem: string): number => {
    stderr(`${problem}\n\n${CITATION_CLI_USAGE}\n`);
    return 2;
  };

  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    return usage(messageOf(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    stdout(`${CITATION_CLI_USAGE}\n`);
    return 0;
  }
  const [command, file, ...extra] = positionals;
  if (command !== 'verify' || file === undefined || extra.length > 0) return usage('agentos-citations takes one command, verify, and one file');
  const embeddings = values.embeddings ?? 'none';
  if (embeddings !== 'none' && embeddings !== 'openai') return usage(`--embeddings takes none or openai, not ${embeddings}`);
  const format = values.format ?? 'auto';
  if (format !== 'auto' && format !== 'markdown' && format !== 'json') return usage(`--format takes auto, markdown or json, not ${format}`);
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    timeoutMs = Number(values.timeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return usage(`--timeout takes a whole number of milliseconds, not ${values.timeout}`);
  }

  const options: CitationCheckOptions = { ...io.options };
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  if (values['no-fallback'] === true) options.fallback = false;
  if (embeddings === 'openai') {
    const apiKey = env.OPENAI_API_KEY;
    if (apiKey === undefined || apiKey === '') {
      stderr('--embeddings openai needs OPENAI_API_KEY in the environment\n');
      return 2;
    }
    const baseUrl = env.OPENAI_BASE_URL;
    options.embedFn = openAIEmbeddings({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
  }

  let text: string;
  try {
    text = file === '-' ? await (io.readStdin ?? processStdin)() : await (io.readFile ?? ((path: string) => readFile(path, 'utf8')))(file);
  } catch (error) {
    stderr(`cannot read ${file}: ${messageOf(error)}\n`);
    return 2;
  }

  let report: CitationReport;
  try {
    report = await checkCitationDocument(text, { ...options, format: format as CitedClaimFormat });
  } catch (error) {
    if (error instanceof CitationInputError || error instanceof CitationSetupError) {
      stderr(`${messageOf(error)}\n`);
      return 2;
    }
    stderr(`the check stopped: ${messageOf(error)}\n`);
    return 2;
  }
  const allowUnreachable = values['allow-unreachable'] === true;
  stdout(values.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderCitationLog(report, { allowUnreachable }));
  return citationReportFails(report, { allowUnreachable }) ? 1 : 0;
}

/** The arguments, read strictly: an unknown option is an error. */
function parseCommand(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean' },
      embeddings: { type: 'string' },
      format: { type: 'string' },
      'allow-unreachable': { type: 'boolean' },
      'no-fallback': { type: 'boolean' },
      timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
