/**
 * @module @framers/agentos-ext-wildweave-film/local
 *
 * The local runner: one run of the film engine's command, `pnpm wildweave-film <subcommand> ...
 * --json`, in the wilds-ai checkout the host names (`WILDWEAVE_FILM_ENGINE_DIR`), through
 * `execFile` with an argument array, never a shell string. Each value goes as `--flag=value` (a
 * `true` as `--flag`, a list joined by commas); a value that begins with `-`, a list item holding a
 * comma, and anything but a string, a number, a boolean or a list of strings are refused
 * (`arg_invalid`). The studio key reaches a child that needs it as `WILDS_IMPORT_TOKEN` in the
 * child's environment, never in its arguments, and a child that does not need it gets neither
 * that variable nor `WILDWEAVE_STUDIO_KEY`. The command prints one JSON object on its last line,
 * `{ ok: true, result, records }` or `{ ok: false, error: { code, message, sceneId } }`, which the
 * runner passes through.
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { Logger } from './log.js';
import { maskDeep, maskKeys } from './log.js';

/** A value the runner passes as a flag. */
export type EngineValue = string | number | boolean | readonly string[];

/** The flags of one run, by camelCase name (`normDir` goes as `--norm-dir`). */
export type EngineArgs = Record<string, EngineValue | undefined>;

/** What a run answers: the command's JSON object, or the runner's refusal. */
export type EngineAnswer =
  | { ok: true; result: unknown; records?: string[] }
  | { ok: false; error: { code: string; message: string; sceneId?: string; details?: Record<string, unknown> } };

/** The callback form of `execFile` the runner calls; tests pass a stub. */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number; windowsHide: boolean },
  callback: (error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null, stdout: string, stderr: string) => void,
) => unknown;

/** Where the engine lives and how long one run may take. */
export interface EngineConfig {
  /** A wilds-ai checkout with the engine installed; without it every local tool answers `engine_missing`. */
  engineDir?: string;
  /** One run's deadline; none by default (a full render runs for hours). */
  engineTimeoutMs?: number;
}

/** What a run needs besides its config. */
export interface EngineDeps {
  execFile?: ExecFileLike;
  log?: Logger;
  /** Values masked in anything the runner returns or logs: the studio key. */
  secrets?: readonly string[];
}

/** The largest output a run may print. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** The variables that carry the studio key; a child gets them only as `WILDS_IMPORT_TOKEN`, and only when it needs it. */
const KEY_VARIABLES = ['WILDWEAVE_STUDIO_KEY', 'WILDS_IMPORT_TOKEN'] as const;

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `normDir` as `norm-dir`. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * The argument array of one run, `['wildweave-film', subcommand, ...flags, '--json']`, or the
 * refusal of a value the runner does not pass.
 */
export function engineArgv(subcommand: string, args: EngineArgs): { ok: true; argv: string[] } | { ok: false; error: { code: 'arg_invalid'; message: string } } {
  const flags: string[] = [];
  const refuse = (message: string) => ({ ok: false as const, error: { code: 'arg_invalid' as const, message } });
  if (!/^[a-z][a-z-]*$/.test(subcommand)) return refuse(`${JSON.stringify(subcommand)} is not a subcommand`);
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === false) continue;
    if (!/^[a-z][A-Za-z]*$/.test(name)) return refuse(`${JSON.stringify(name)} is not a flag name`);
    const flag = `--${kebab(name)}`;
    if (value === true) {
      flags.push(flag);
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return refuse(`${flag} is not a finite number`);
      flags.push(`${flag}=${value}`);
    } else if (typeof value === 'string') {
      if (value.startsWith('-')) return refuse(`${flag} begins with "-", which the command would read as a flag`);
      if (value.includes('\u0000')) return refuse(`${flag} holds a NUL`);
      flags.push(`${flag}=${value}`);
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      const items = value as readonly string[];
      if (items.length === 0) return refuse(`${flag} names nothing`);
      for (const item of items) {
        if (item.startsWith('-')) return refuse(`${flag} holds ${JSON.stringify(item)}, which begins with "-"`);
        if (item.includes(',') || item.includes('\u0000') || item === '') return refuse(`${flag} holds ${JSON.stringify(item)}: an item is not empty and holds no comma`);
      }
      flags.push(`${flag}=${items.join(',')}`);
    } else {
      return refuse(`${flag} is not a string, a number, a boolean or a list of strings`);
    }
  }
  return { ok: true, argv: ['wildweave-film', subcommand, ...flags, '--json'] };
}

/** The last line of the output that holds the command's JSON object, or null. */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRec(value) && typeof value.ok === 'boolean') return value;
    } catch {
      // Not the command's object: an earlier line, or a log line.
    }
    return null;
  }
  return null;
}

/** The tail of the child's stderr, masked, for a run that printed no JSON. */
function stderrTail(stderr: string, secrets: readonly string[]): string {
  const lines = stderr.split('\n').filter((line) => line.trim() !== '');
  return maskKeys(lines.slice(-12).join('\n'), secrets).slice(-2_000);
}

/**
 * One run of the engine's command. `env.WILDS_IMPORT_TOKEN`, when given, is the one way the key
 * reaches the child. Resolves with the command's object or the runner's refusal; never throws.
 */
export async function runEngine(config: EngineConfig, subcommand: string, args: EngineArgs, env: { WILDS_IMPORT_TOKEN?: string } = {}, deps: EngineDeps = {}): Promise<EngineAnswer> {
  const secrets = [...(deps.secrets ?? []), ...(env.WILDS_IMPORT_TOKEN ? [env.WILDS_IMPORT_TOKEN] : [])];
  if (!config.engineDir) {
    return { ok: false, error: { code: 'engine_missing', message: 'no film engine: set WILDWEAVE_FILM_ENGINE_DIR (or options.engineDir) to a wilds-ai checkout with its dependencies installed' } };
  }
  const isDir = await stat(config.engineDir).then((s) => s.isDirectory()).catch(() => false);
  if (!isDir) return { ok: false, error: { code: 'engine_missing', message: `the engine directory ${config.engineDir} is not a folder on this machine` } };
  const built = engineArgv(subcommand, args);
  if (!built.ok) return built;

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of KEY_VARIABLES) delete childEnv[name];
  if (env.WILDS_IMPORT_TOKEN) childEnv.WILDS_IMPORT_TOKEN = env.WILDS_IMPORT_TOKEN;

  const run = deps.execFile ?? (nodeExecFile as unknown as ExecFileLike);
  const started = Date.now();
  const outcome = await new Promise<{ error: (Error & { code?: unknown; killed?: boolean; signal?: unknown }) | null; stdout: string; stderr: string }>((resolve) => {
    try {
      run(
        'pnpm',
        built.argv,
        { cwd: config.engineDir!, env: childEnv, maxBuffer: MAX_BUFFER, timeout: config.engineTimeoutMs ?? 0, windowsHide: true },
        (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
      );
    } catch (err) {
      resolve({ error: err as Error, stdout: '', stderr: '' });
    }
  });
  const wallMs = Date.now() - started;
  const exitCode = outcome.error ? (typeof outcome.error.code === 'number' ? outcome.error.code : null) : 0;
  const stderrLines = outcome.stderr.split('\n').filter((line) => line.trim() !== '').length;
  deps.log?.info({ event: 'wildweave_film.engine_run', subcommand, exitCode, wallMs, stderrLines }, 'the film engine ran');
  if (stderrLines > 0) deps.log?.debug({ event: 'wildweave_film.engine_stderr', subcommand, tail: stderrTail(outcome.stderr, secrets) }, 'the film engine wrote to stderr');

  const printed = lastJsonObject(outcome.stdout);
  if (printed) return maskDeep(printed, secrets) as EngineAnswer;
  if (outcome.error?.code === 'ENOENT') {
    return { ok: false, error: { code: 'engine_failed', message: 'pnpm was not found on this machine; the engine runs as pnpm wildweave-film in its checkout' } };
  }
  if (outcome.error?.killed) {
    return { ok: false, error: { code: 'engine_timeout', message: `the engine ran past ${config.engineTimeoutMs ?? 0} ms and was stopped`, details: { subcommand, wallMs } } };
  }
  return {
    ok: false,
    error: {
      code: 'engine_failed',
      message: `the engine printed no JSON answer (exit ${exitCode ?? 'unknown'})`,
      details: { subcommand, exitCode, stderr: stderrTail(outcome.stderr, secrets) },
    },
  };
}
