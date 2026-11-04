/**
 * @module @framers/agentos-ext-wildweave-film/tools
 *
 * The 22 tool definitions, shared by the AgentOS pack and the MCP server: each one's name, what it
 * does and its refusal codes, its mode (remote, local or both), its scope, whether it has side
 * effects, and `run`, which checks the arguments against the tool's schema and answers one object:
 * `{ ok: true, result }` or `{ ok: false, error: { code, message, ... } }`.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { StudioAnswer, StudioError, WildweaveStudioClient } from './client.js';
import { exportFilm } from './export.js';
import type { EngineAnswer, EngineArgs } from './local.js';
import type { Logger } from './log.js';
import type { ZodType } from 'zod';
import { TOOL_SCHEMAS, type ToolInput, type ToolName } from './schemas.js';

/** What a tool answers. */
export type ToolAnswer = { ok: true; result: unknown; requestId?: string; records?: string[] } | { ok: false; error: StudioError };

/** What a tool runs with. */
export interface ToolContext {
  client: WildweaveStudioClient;
  /** One run of the engine's command; `WILDS_IMPORT_TOKEN` is the key, for the subcommands that post to the studio. */
  engine: (subcommand: string, args: EngineArgs, env?: { WILDS_IMPORT_TOKEN?: string }) => Promise<EngineAnswer>;
  /** The film repository, the default for `film` and the root of the export's writes. */
  filmRepo?: string;
  /** The studio's origin, passed to the subcommands that post to it as `--base-url`. */
  baseUrl: string;
  /** The studio key, for the subcommands that post to the studio. */
  key?: string;
  /** True when an engine directory is configured: the export then cuts and validates what it writes. */
  engineConfigured: boolean;
  log: Logger;
}

/** One tool. */
export interface ToolDefinition {
  name: ToolName;
  displayName: string;
  /** What the tool does and the refusals it answers: what the model reads. */
  description: string;
  mode: 'remote' | 'local' | 'both';
  scope: 'read' | 'write' | 'render' | 'import';
  hasSideEffects: boolean;
  run(args: unknown, ctx: ToolContext): Promise<ToolAnswer>;
}

const refuse = (code: string, message: string, details?: Record<string, unknown>): ToolAnswer => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });

/** A route's answer as a tool's: the result and its request id, or the refusal. */
function fromStudio(answer: StudioAnswer): ToolAnswer {
  return answer.ok ? { ok: true, result: answer.result, requestId: answer.requestId } : answer;
}

/** The configured film repository as an absolute path, or undefined. */
const repoOf = (ctx: ToolContext): string | undefined => (ctx.filmRepo === undefined ? undefined : resolve(ctx.filmRepo));

/**
 * A path argument as an absolute path: a relative one lies under the film repository when one is configured, where
 * the defaults beside it (the cut's timeline and sidecar, the validate's assets, the export's writeTo) point, else
 * under the working directory.
 */
const abs = (ctx: ToolContext, p: string | undefined): string | undefined => (p === undefined ? undefined : resolve(repoOf(ctx) ?? '.', p));

/** The film repository a subcommand reads: the argument, else the configured one. */
function filmOf(film: string | undefined, ctx: ToolContext): string | undefined {
  return abs(ctx, film) ?? repoOf(ctx);
}

/**
 * One definition from its parts: `run` parses the arguments with the tool's input schema first,
 * so a body the schema refuses never reaches a route or the command (`arg_invalid` with the issues).
 */
function define<N extends ToolName>(
  name: N,
  displayName: string,
  mode: ToolDefinition['mode'],
  scope: ToolDefinition['scope'],
  description: string,
  body: (input: ToolInput<N>, ctx: ToolContext) => Promise<ToolAnswer>,
): ToolDefinition {
  return {
    name,
    displayName,
    description,
    mode,
    scope,
    // The export reads at the gate's scope, and with writeTo writes the repository's files and acknowledges them; the
    // cut reads at the read scope and writes its cut.json to the out the caller names.
    hasSideEffects: scope !== 'read' || name === 'wildweave_film_export' || name === 'wildweave_film_cut',
    async run(args, ctx) {
      const parsed = (TOOL_SCHEMAS[name].input as ZodType).safeParse(args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
        const first = issues[0];
        return refuse('arg_invalid', first ? `${first.path || 'the arguments'}: ${first.message}` : 'the arguments do not match the tool', { issues });
      }
      return body(parsed.data as ToolInput<N>, ctx);
    },
  };
}

/** The JSON files a render folder keeps, by the field the records tool answers them under. */
const RECORD_FILES: ReadonlyArray<readonly [string, string]> = [
  ['record', 'film.record.json'],
  ['plan', 'reports/plan.json'],
  ['validate', 'reports/validate.json'],
  ['inspect', 'reports/inspect.json'],
  ['coverage', 'reports/coverage.json'],
  ['strips', 'strips/index.json'],
  ['preview', 'reports/preview.json'],
  ['run', 'run.json'],
];

/** The records of a render folder: each JSON file it holds, read, and the names of its top-level files. */
async function readRecords(out: string): Promise<ToolAnswer> {
  let entries: string[];
  try {
    entries = (await readdir(out, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort().slice(0, 500);
  } catch {
    return refuse('not_found', `${out} is not a render folder on this machine`);
  }
  const result: Record<string, unknown> = {};
  for (const [field, file] of RECORD_FILES) {
    const text = await readFile(join(out, file), 'utf8').catch(() => null);
    if (text === null) continue;
    try {
      result[field] = JSON.parse(text) as unknown;
    } catch {
      result[field] = { unreadable: true };
    }
  }
  result.artifacts = entries;
  return { ok: true, result };
}

/** The 22 tools, in the order of the studio's tool surface. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  define('wildweave_film_list', 'WildWeave Film List', 'remote', 'read', "Lists the films the account's studio holds (v1: at most one), each with its id, title, scene count, length and whether it was edited since the import. Refusals: key_missing, key_rejected, forge_required, scope_required.", async (_input, ctx) =>
    fromStudio(await ctx.client.listFilms()),
  ),
  define('wildweave_film_documents', 'WildWeave Film Documents', 'remote', 'read', "Lists the documents the film's import binds, each with its import key, kind, edit time and whether it changed since the import. Refusals: not_found, key_missing, key_rejected, forge_required.", async (input, ctx) =>
    fromStudio(await ctx.client.documents(input.filmId)),
  ),
  define('wildweave_film_document_read', 'WildWeave Film Document Read', 'remote', 'read', 'Reads one bound document with its content, edit time and import key. Refusals: not_found, key_missing, key_rejected, forge_required.', async (input, ctx) =>
    fromStudio(await ctx.client.document(input.documentId)),
  ),
  define('wildweave_film_timeline', 'WildWeave Film Timeline', 'remote', 'read', "Reads the film's timeline and sidecar as the export would write them, their sha256, every document's edit time (the ifUpdatedAtMs an edit sends back) and each scene's readiness. Refusals: not_found, film_unreadable, key_missing.", async (input, ctx) =>
    fromStudio(await ctx.client.timeline(input.filmId)),
  ),
  define('wildweave_film_scene', 'WildWeave Film Scene', 'remote', 'read', "Reads one scene: as the timeline holds it, its sidecar entry, its readiness and the in-app validate's findings for it. Refusals: scene_unknown, not_found, key_missing.", async (input, ctx) =>
    fromStudio(await ctx.client.scene(input.filmId, input.sceneId)),
  ),
  define('wildweave_film_validate', 'WildWeave Film Validate', 'both', 'read', "Validates the film: with filmId, the in-app validate over the account's documents (the engine's own checker at draft, files answered from the import record); with cut, the local engine's validate over a cut.json and the repository's files, the authoritative check before a render. Answers ok (no error finding), the findings, by scene, the counts and the cut's sha256. Refusals: arg_invalid, not_found, key_missing, engine_missing.", async (input, ctx) => {
    if ((input.filmId === undefined) === (input.cut === undefined)) return refuse('arg_invalid', 'give filmId (validate in the app) or cut (validate with the local engine), not both');
    if (input.filmId !== undefined) return fromStudio(await ctx.client.validate(input.filmId));
    const assets = abs(ctx, input.assets) ?? repoOf(ctx);
    if (!assets) return refuse('arg_invalid', 'assets: the film repository the cut reads (or set WILDWEAVE_FILM_REPO)');
    return ctx.engine('validate', { cut: abs(ctx, input.cut), assets, draft: input.draft, strict: input.strict });
  }),
  define('wildweave_film_edit', 'WildWeave Film Edit', 'remote', 'write', "Applies edit ops to the film's timeline unit (reorder, move, trim, clip_window, clip_sound, transition, bed, beds, marks, marks_table, layers), guarded by the edit times read with wildweave_film_timeline, then validates; answers seq, the findings and the new hashes and edit times. A retry with the same editId and body is applied once. Refusals: stale_write (read again and decide), edit_refused (an op's code, or the engine's findings), edit_id_reused, record_reimport_required, not_found.", async (input, ctx) =>
    fromStudio(await ctx.client.edit(input.filmId, { editId: input.editId, ifUpdatedAtMs: input.ifUpdatedAtMs, ops: input.ops, ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) })),
  ),
  define('wildweave_film_edits', 'WildWeave Film Edit Log', 'remote', 'read', "Reads the film's edit log after a seq, oldest first: each row's seq, kind (edit, revert, import or ack), editId, time, who made it (the account, and the key when a key did), its ops and the hashes after it. Refusals: not_found, key_missing.", async (input, ctx) =>
    fromStudio(await ctx.client.edits(input.filmId, input.since)),
  ),
  define('wildweave_film_revert', 'WildWeave Film Revert', 'remote', 'write', "Puts the timeline unit back as it was before the edit log's row toSeq, guarded by the edit times read with wildweave_film_timeline, and logs a revert row; the sources baseline and the bindings are never restored. Refusals: seq_unknown, import_between (an import row lies between; force crosses it, on his word alone), stale_write, not_found.", async (input, ctx) =>
    fromStudio(await ctx.client.revert(input.filmId, { toSeq: input.toSeq, ifUpdatedAtMs: input.ifUpdatedAtMs, ...(input.force === undefined ? {} : { force: input.force }) })),
  ),
  define('wildweave_film_import', 'WildWeave Film Import', 'local', 'import', "Imports the film repository into the account with the local engine (pnpm wildweave-film import): dry-run plans and writes nothing, production posts the bundle with the studio key. A document edited in WildWeave since the import is a conflict unless force. Refusals: engine_missing, key_missing (production), arg_invalid, and the command's own codes.", async (input, ctx) => {
    const film = filmOf(input.film, ctx);
    if (!film) return refuse('arg_invalid', 'film: the film repository (or set WILDWEAVE_FILM_REPO)');
    // Without an engine the runner answers engine_missing first; with one, a production import needs the key.
    if (ctx.engineConfigured && input.target === 'production' && !ctx.key) return refuse('key_missing', 'no studio key: set WILDWEAVE_STUDIO_KEY or the options.key of the pack');
    const args: EngineArgs = {
      film,
      out: abs(ctx, input.out),
      ...(input.target === 'dry-run' ? { dryRun: true } : { target: input.target }),
      force: input.force,
      exportCheck: input.exportCheck,
      baseUrl: ctx.baseUrl,
    };
    return ctx.engine('import', args, input.target === 'production' && ctx.key ? { WILDS_IMPORT_TOKEN: ctx.key } : {});
  }),
  define('wildweave_film_export', 'WildWeave Film Export', 'remote', 'read', "Exports the film's sources (script, beat sheet, takes, timeline, sidecar) from the account: each text, its sha256 and baseSha256 (the file as the repository last held it). With writeTo it writes them into the film repository all or nothing (a rollback the file system refuses is named in details.unrestored and details.notRemoved, never claimed done), refusing a file that changed there since (source_changed, unless force), cuts and validates the set with the local engine when one is configured (export_invalid on an error), then acknowledges the written hashes to the studio; the texts are then left out of the answer. Refusals: source_changed, export_invalid, path_outside_repo, film_repo_missing, stale_write (the acknowledgement), export_refused, not_found.", async (input, ctx) =>
    exportFilm(
      { filmId: input.filmId, writeTo: input.writeTo, force: input.force, paths: input.paths },
      { client: ctx.client, filmRepo: ctx.filmRepo, ...(ctx.engineConfigured ? { engine: (subcommand: string, args: EngineArgs) => ctx.engine(subcommand, args) } : {}) },
    ),
  ),
  define('wildweave_film_inspect', 'WildWeave Film Inspect', 'both', 'read', "Inspects the cut: with filmId, the engine's inspect over the cut the account's documents give; with cut, the local engine's inspect over a cut.json. Answers the scenes in order with their starts, lengths, lines, visuals and transitions, the chapters and the findings' counts. Refusals: cut_refused, arg_invalid, not_found, engine_missing.", async (input, ctx) => {
    if ((input.filmId === undefined) === (input.cut === undefined)) return refuse('arg_invalid', 'give filmId (inspect in the app) or cut (inspect with the local engine), not both');
    if (input.filmId !== undefined) return fromStudio(await ctx.client.inspect(input.filmId));
    return ctx.engine('inspect', { cut: abs(ctx, input.cut), assets: abs(ctx, input.assets) });
  }),
  define('wildweave_film_cut', 'WildWeave Film Cut', 'local', 'read', "Makes the cut from the timeline and the sidecar with the local engine (pnpm wildweave-film cut): the film repository's production/timeline.json and production/render.json by default. Refusals: engine_missing, arg_invalid, and the command's own codes (the cut's findings).", async (input, ctx) => {
    const repo = repoOf(ctx);
    const timeline = abs(ctx, input.timeline) ?? (repo ? join(repo, 'production', 'timeline.json') : undefined);
    const sidecar = abs(ctx, input.sidecar) ?? (repo ? join(repo, 'production', 'render.json') : undefined);
    if (!timeline) return refuse('arg_invalid', 'timeline: the timeline.json (or set WILDWEAVE_FILM_REPO)');
    return ctx.engine('cut', { timeline, sidecar, assets: abs(ctx, input.assets), out: abs(ctx, input.out), normDir: abs(ctx, input.normDir), takes: abs(ctx, input.takes), draft: input.draft });
  }),
  define('wildweave_film_strip', 'WildWeave Film Strip', 'local', 'render', 'Draws contact sheets of a scene or of every scene with the local engine (pnpm wildweave-film strip), the check before a long render. Refusals: engine_missing, arg_invalid, and the command\'s own codes.', async (input, ctx) => {
    if ((input.scene === undefined) === (input.all !== true)) return refuse('arg_invalid', 'give scene (one scene) or all (every scene)');
    return ctx.engine('strip', { cut: abs(ctx, input.cut), assets: abs(ctx, input.assets), out: abs(ctx, input.out), scene: input.scene, all: input.all, frames: input.frames });
  }),
  define('wildweave_film_coverage', 'WildWeave Film Coverage', 'local', 'render', "Checks that every scene's picture can be drawn, with the local engine (pnpm wildweave-film coverage). Refusals: engine_missing, arg_invalid, and the command's own codes.", async (input, ctx) =>
    ctx.engine('coverage', { cut: abs(ctx, input.cut), assets: abs(ctx, input.assets), out: abs(ctx, input.out) }),
  ),
  define('wildweave_film_render', 'WildWeave Film Render', 'both', 'render', "Renders the cut: with cut, assets and out, the local engine renders a draft or the master (jobs auto by default: sized from free memory and cores; requireStrips refuses a cut whose strips are stale); with filmId, a render job on the box, which answers not_open until the render worker ships. The order before a long render: strip all, validate strict, coverage, then render strict with requireStrips. Refusals: not_open, kind_not_local, engine_missing, arg_invalid, and the command's own codes.", async (input, ctx) => {
    if ((input.filmId === undefined) === (input.cut === undefined)) return refuse('arg_invalid', 'give cut (render on this machine) or filmId (a job on the box), not both');
    if (input.filmId !== undefined) {
      const { filmId, ...job } = input;
      return fromStudio(await ctx.client.startJob(filmId, job));
    }
    if (input.kind !== 'draft' && input.kind !== 'master') {
      return refuse('kind_not_local', `a local render makes a draft or the master; ${input.kind} is the strip or coverage tool's, or the command's own`);
    }
    if (!input.assets || !input.out) return refuse('arg_invalid', 'a local render needs assets and out beside cut');
    return ctx.engine('render', {
      cut: abs(ctx, input.cut),
      assets: abs(ctx, input.assets),
      out: abs(ctx, input.out),
      draft: input.kind === 'draft',
      strict: input.strict,
      jobs: input.jobs ?? 'auto',
      by: input.by,
      scene: input.scene,
      part: input.part,
      resume: input.resume,
      requireStrips: input.requireStrips,
    });
  }),
  define('wildweave_film_records', 'WildWeave Film Records', 'both', 'read', "Reads a render's records: with out, the render folder's film.record.json, its reports (plan, validate, inspect, coverage, preview), strips/index.json, run.json and its file names; with filmId and jobId, a render job on the box (not_open until the worker ships). Refusals: not_found, not_open, arg_invalid.", async (input, ctx) => {
    if (input.out !== undefined) return readRecords(abs(ctx, input.out)!);
    if (input.filmId !== undefined && input.jobId !== undefined) return fromStudio(await ctx.client.job(input.filmId, input.jobId));
    return refuse('arg_invalid', 'give out (a render folder on this machine), or filmId and jobId (a job on the box)');
  }),
  define('wildweave_film_preview', 'WildWeave Film Preview', 'remote', 'read', "Reads the film's preview: the page where the player plays it, each scene's readiness (a placeholder is never ready), the staged parts and beds, and every document's edit time. Refusals: not_found, key_missing.", async (input, ctx) =>
    fromStudio(await ctx.client.preview(input.filmId)),
  ),
  define('wildweave_film_preview_push', 'WildWeave Film Preview Push', 'local', 'write', "Pushes a draft render's parts (and, with beds, the beds' encoded copies) into the account's preview with the local engine (pnpm wildweave-film preview): stages each file through the studio and posts once; answers what was pushed, what was there already (unchanged, bedsUnchanged), what was skipped and why, and the readiness after. Refusals: key_missing, engine_missing, and the command's own codes (stale_write, files_not_staged).", async (input, ctx) => {
    const film = filmOf(input.film, ctx);
    if (!film) return refuse('arg_invalid', 'film: the film repository (or set WILDWEAVE_FILM_REPO)');
    if (ctx.engineConfigured && !ctx.key) return refuse('key_missing', 'no studio key: set WILDWEAVE_STUDIO_KEY or the options.key of the pack');
    return ctx.engine('preview', { film, out: abs(ctx, input.out), target: 'production', scenes: input.scenes, beds: input.beds, render: input.render, baseUrl: ctx.baseUrl }, ctx.key ? { WILDS_IMPORT_TOKEN: ctx.key } : {});
  }),
  define('wildweave_film_proposals', 'WildWeave Film Proposals', 'remote', 'read', "Lists the film's proposals (the yes-list) oldest first, optionally by status (proposed, yes, no, noted), each with its rights line and his verdict in his words. Refusals: not_found, key_missing.", async (input, ctx) =>
    fromStudio(await ctx.client.proposals(input.filmId, input.status)),
  ),
  define('wildweave_film_proposal_submit', 'WildWeave Film Proposal Submit', 'remote', 'write', "Submits a proposal for a scene (a clip, a meme, a mark, a split or other) with its rights line, which no tool decides. The proposal's id is the proposalId you give, else one the tool names, so a retry after a lost answer keeps one proposal and answers it with replayed: true. Refusals: proposal_id_reused (the id under another body), scene_unknown, invalid_body, not_found, key_missing.", async (input, ctx) => {
    const { filmId, ...body } = input;
    // A named id makes the POST idempotent on the route, so the client may retry it after a network error or a 502.
    return fromStudio(await ctx.client.submitProposal(filmId, { ...body, proposalId: body.proposalId ?? randomUUID() }));
  }),
  define('wildweave_film_proposal_decide', 'WildWeave Film Proposal Decide', 'remote', 'write', "Records his verdict on a proposal (yes, no or note) with his words verbatim and where he said it; a note can still be decided, a yes or a no stands. The same decision sent again answers the one that stands. Refusals: already_decided, source_app_needs_session (a key sends source relayed), not_found, key_missing.", async (input, ctx) =>
    fromStudio(await ctx.client.decideProposal(input.filmId, input.proposalId, { verdict: input.verdict, words: input.words, source: input.source })),
  ),
];

/** The definition of a tool by its name. */
export function toolDefinition(name: ToolName): ToolDefinition {
  const def = TOOL_DEFINITIONS.find((d) => d.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}
