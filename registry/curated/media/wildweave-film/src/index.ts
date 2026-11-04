/**
 * @module @framers/agentos-ext-wildweave-film
 *
 * WildWeave's film studio as AgentOS tools. `createExtensionPack(context)` resolves its
 * configuration (the studio key from `options.key`, then the secret `wildweave.studio.key`, then
 * `WILDWEAVE_STUDIO_KEY`; the base URL, the engine directory and the film repository the same way
 * from options, then the environment) and returns one `tool` descriptor per tool, each descriptor's
 * id the tool's `name`, the key `ToolExecutor` looks a call up by. A pack with no key still loads:
 * every remote tool then answers `key_missing`, and without an engine directory every local tool
 * answers `engine_missing`, so a host can list the tools before it is configured.
 *
 * @example
 * ```ts
 * import { AgentOS } from '@framers/agentos';
 *
 * const agentos = await AgentOS.create({
 *   extensionManifest: { packs: [{ package: '@framers/agentos-ext-wildweave-film', options: { baseUrl: 'https://wilds.ai' } }] },
 * });
 * ```
 */
import { createRequire } from 'node:module';
import type { DestinationStream } from 'pino';
import { WildweaveStudioClient } from './client.js';
import { runEngine, type EngineArgs, type ExecFileLike } from './local.js';
import { createLogger, type Logger } from './log.js';
import { toolJsonSchema } from './schemas.js';
import { TOOL_DEFINITIONS, type ToolAnswer, type ToolContext, type ToolDefinition } from './tools.js';

/** The pack's version, read from its package.json. */
export const PACKAGE_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/** The pack's name. */
export const PACKAGE_NAME = '@framers/agentos-ext-wildweave-film';

/** The secret id a host stores the studio key under. */
export const STUDIO_KEY_SECRET = 'wildweave.studio.key';

/** Options a host passes the pack (or the environment variables of the same meaning). */
export interface WildweaveFilmPackOptions {
  /** The per-account studio key; else the secret `wildweave.studio.key`, else `WILDWEAVE_STUDIO_KEY`. */
  key?: string;
  /** The studio's origin; else `WILDWEAVE_STUDIO_BASE_URL`, else `https://wilds.ai`. */
  baseUrl?: string;
  /** A wilds-ai checkout with the engine installed; else `WILDWEAVE_FILM_ENGINE_DIR`. */
  engineDir?: string;
  /** The film repository; else `WILDWEAVE_FILM_REPO`. */
  filmRepo?: string;
  /** The descriptors' priority; 30 by default. */
  priority?: number;
  /** pino's level; else `WILDWEAVE_FILM_LOG_LEVEL`, else `info`. */
  logLevel?: string;
  /** One remote call's deadline in milliseconds; else `WILDWEAVE_FILM_TIMEOUT_MS`, else 30,000. */
  timeoutMs?: number;
  /** One engine run's deadline in milliseconds; none by default. */
  engineTimeoutMs?: number;
}

/** The pack's configuration once resolved. The key is never logged. */
export interface PackConfig {
  key?: string;
  baseUrl: string;
  engineDir?: string;
  filmRepo?: string;
  logLevel: string;
  timeoutMs: number;
  engineTimeoutMs?: number;
}

/** A secret reader, as AgentOS's pack context gives one. */
export type SecretReader = (id: string) => string | undefined | Promise<string | undefined>;

const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** The studio key the host's secret reader holds; a reader that throws holds none. */
async function readSecret(getSecret?: SecretReader): Promise<string | undefined> {
  if (!getSecret) return undefined;
  try {
    return nonEmpty(await getSecret(STUDIO_KEY_SECRET));
  } catch {
    return undefined;
  }
}

/** The configuration from the options, then the secret reader, then the environment. */
export async function resolveConfig(options: WildweaveFilmPackOptions = {}, getSecret?: SecretReader, env: NodeJS.ProcessEnv = process.env): Promise<PackConfig> {
  const key = nonEmpty(options.key) ?? (await readSecret(getSecret)) ?? nonEmpty(env.WILDWEAVE_STUDIO_KEY);
  const level = nonEmpty(options.logLevel) ?? nonEmpty(env.WILDWEAVE_FILM_LOG_LEVEL) ?? 'info';
  const timeout = options.timeoutMs ?? Number(env.WILDWEAVE_FILM_TIMEOUT_MS ?? '');
  const config: PackConfig = {
    baseUrl: nonEmpty(options.baseUrl) ?? nonEmpty(env.WILDWEAVE_STUDIO_BASE_URL) ?? 'https://wilds.ai',
    logLevel: LEVELS.has(level) ? level : 'info',
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
  };
  if (key) config.key = key;
  const engineDir = nonEmpty(options.engineDir) ?? nonEmpty(env.WILDWEAVE_FILM_ENGINE_DIR);
  if (engineDir) config.engineDir = engineDir;
  const filmRepo = nonEmpty(options.filmRepo) ?? nonEmpty(env.WILDWEAVE_FILM_REPO);
  if (filmRepo) config.filmRepo = filmRepo;
  if (options.engineTimeoutMs !== undefined && options.engineTimeoutMs > 0) config.engineTimeoutMs = options.engineTimeoutMs;
  return config;
}

/** What a tool context may take in place of the real network, process and timer. */
export interface ToolContextDeps {
  fetch?: typeof fetch;
  execFile?: ExecFileLike;
  sleep?: (ms: number) => Promise<void>;
}

/** The context every tool runs with, built once from the configuration. */
export function createToolContext(config: PackConfig, log: Logger, deps: ToolContextDeps = {}): ToolContext {
  const secrets = config.key ? [config.key] : [];
  const client = new WildweaveStudioClient({
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    log,
    ...(config.key ? { key: config.key } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  return {
    client,
    engine: (subcommand: string, args: EngineArgs, env = {}) =>
      runEngine({ ...(config.engineDir ? { engineDir: config.engineDir } : {}), ...(config.engineTimeoutMs ? { engineTimeoutMs: config.engineTimeoutMs } : {}) }, subcommand, args, env, {
        log,
        secrets,
        ...(deps.execFile ? { execFile: deps.execFile } : {}),
      }),
    ...(config.filmRepo ? { filmRepo: config.filmRepo } : {}),
    ...(config.key ? { key: config.key } : {}),
    baseUrl: config.baseUrl,
    engineConfigured: config.engineDir !== undefined,
    log,
  };
}

/** A tool as AgentOS's `ITool` names its fields (structurally; the pack imports nothing from AgentOS at run time). */
export interface WildweaveFilmTool {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly category: string;
  readonly version: string;
  readonly hasSideEffects: boolean;
  execute(args: Record<string, unknown>, context?: unknown): Promise<{ success: boolean; output?: ToolAnswer; error?: string }>;
}

/** The AgentOS tool of one definition: its JSON Schemas, and `execute` answering `{ success, output, error }`. */
export function toITool(def: ToolDefinition, ctx: ToolContext): WildweaveFilmTool {
  const verb = def.name.replace(/^wildweave_film_/, '').replace(/_/g, '-');
  const { input, output } = toolJsonSchema(def.name);
  return {
    id: `com.framers.media.wildweave-film.${verb}`,
    name: def.name,
    displayName: def.displayName,
    description: def.description,
    inputSchema: input,
    outputSchema: output,
    category: 'media',
    version: PACKAGE_VERSION,
    hasSideEffects: def.hasSideEffects,
    async execute(args) {
      const started = Date.now();
      const answer = await def.run(args, ctx);
      ctx.log.info(
        { event: 'wildweave_film.call', tool: def.name, mode: def.mode, host: 'agentos', ok: answer.ok, ms: Date.now() - started, ...(answer.ok ? {} : { code: answer.error.code }), requestId: answer.ok ? answer.requestId : answer.error.requestId },
        'tool call',
      );
      return answer.ok ? { success: true, output: answer } : { success: false, output: answer, error: answer.error.message };
    },
  };
}

/** One descriptor of the pack, as AgentOS's `ExtensionDescriptor` names its fields. */
export interface WildweaveFilmDescriptor {
  id: string;
  kind: 'tool';
  priority: number;
  payload: WildweaveFilmTool;
  requiredSecrets?: Array<{ id: string; optional?: boolean; description?: string }>;
}

/** The pack, as AgentOS's `ExtensionPack` names its fields. */
export interface WildweaveFilmPack {
  name: string;
  version: string;
  descriptors: WildweaveFilmDescriptor[];
  onActivate: () => Promise<void>;
  onDeactivate: () => Promise<void>;
}

/** What the pack reads from AgentOS's `ExtensionPackContext`. */
export interface WildweaveFilmPackContext {
  options?: Record<string, unknown>;
  logger?: unknown;
  getSecret?: SecretReader;
  /** Where the pack's log lines go; stderr by default. */
  logDestination?: DestinationStream;
  /** Stand-ins for the network and the engine's process, for a test host. */
  deps?: ToolContextDeps;
}

/** The AgentOS pack: one `tool` descriptor per tool, the descriptor's id the tool's name. */
export async function createExtensionPack(context: WildweaveFilmPackContext = {}): Promise<WildweaveFilmPack> {
  const options = (context.options ?? {}) as WildweaveFilmPackOptions;
  const config = await resolveConfig(options, context.getSecret);
  const log = createLogger({ level: config.logLevel, secrets: config.key ? [config.key] : [], ...(context.logDestination ? { destination: context.logDestination } : {}) });
  const ctx = createToolContext(config, log, context.deps);
  const priority = typeof options.priority === 'number' ? options.priority : 30;
  const descriptors: WildweaveFilmDescriptor[] = TOOL_DEFINITIONS.map((def) => {
    const tool = toITool(def, ctx);
    return {
      id: tool.name,
      kind: 'tool' as const,
      priority,
      payload: tool,
      ...(def.mode === 'local' ? {} : { requiredSecrets: [{ id: STUDIO_KEY_SECRET, optional: true, description: 'The per-account studio key; without it the tool answers key_missing' }] }),
    };
  });
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    descriptors,
    onActivate: async () => {
      log.info({ event: 'wildweave_film.activated', tools: descriptors.length, remote: config.key !== undefined, local: config.engineDir !== undefined }, 'pack activated');
    },
    onDeactivate: async () => {
      log.info({ event: 'wildweave_film.deactivated' }, 'pack deactivated');
    },
  };
}

export default createExtensionPack;

export { WildweaveStudioClient } from './client.js';
export type { StudioAnswer, StudioError, WildweaveStudioClientOptions } from './client.js';
export { TOOL_SCHEMAS, TOOL_NAMES, toolJsonSchema, toolResult, filmEditOp, type FilmEditOp, type ToolName, type ToolInput } from './schemas.js';
export { TOOL_DEFINITIONS, toolDefinition, type ToolAnswer, type ToolContext, type ToolDefinition } from './tools.js';
export { DEFAULT_SOURCE_PATHS } from './export.js';
export { engineArgv, runEngine, type EngineAnswer, type EngineArgs, type ExecFileLike } from './local.js';
export { createLogger, maskKeys } from './log.js';
