/**
 * @module @framers/agentos-ext-wildweave-film/schemas
 *
 * One Zod schema per tool's input and output, the source of the JSON Schemas (draft-07) a host
 * reads: AgentOS's `ToolExecutor` validates a call's arguments and its output against them, and
 * the MCP server lists them in `tools/list`. Inputs are strict: a field a tool does not name is
 * refused, never dropped, so a misspelt `licence` or `editId` reaches the caller as a refusal.
 * Outputs are loose: a route may answer fields a later release adds, and a host must not fail a
 * call for them.
 */
import * as z from 'zod';

// ── Shared pieces ───────────────────────────────────────────────────────────────────────────────

const filmId = z.string().min(1).max(200).describe('The film id, as wildweave_film_list returns it');
const documentId = z.string().min(1).max(200).describe('A bound document id, as wildweave_film_documents returns it');
const sceneId = z.string().min(1).max(128).describe('A scene id of the timeline, such as s02');
const filePath = z.string().min(1).max(4096);

/**
 * An RFC 9562 UUID, zod 4's `z.uuid()` pattern: the form the proposals route admits for a client-named
 * `proposalId` (any other 8-4-4-4-12 hex answers 400 `invalid_body` there). Written as a pattern so its
 * JSON Schema is a `pattern` alone, which every validator reads, and not a `format` some do not know.
 */
const RFC_9562_UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

/** The edit times a write is guarded by: every document of the timeline unit, as wildweave_film_timeline answers them. */
export const ifUpdatedAtMs = z
  .record(z.string(), z.number().int().min(0))
  .describe('The edit time of every document of the timeline unit, by import key, exactly as wildweave_film_timeline answers updatedAtMs; a document changed since answers stale_write');

/** A finding of the engine's checker, as the routes and the command report one. */
export const cutFinding = z
  .looseObject({
    level: z.enum(['error', 'warning', 'note']),
    code: z.string(),
    message: z.string(),
    sceneId: z.string().optional(),
  })
  .describe('A finding of the cut checker: an error refuses a render or an edit; a warning or a note does not');

const sceneReadiness = z.looseObject({
  picture: z.enum(['ready', 'stale', 'placeholder', 'missing']),
  voice: z.record(z.string(), z.enum(['ready', 'stand-in', 'missing'])),
  bed: z.enum(['ready', 'missing']),
  sound: z.enum(['ok', 'local-only']),
});

/** A film's readiness: what the account's player shows for each scene, and the count of each picture state. */
export const readiness = z
  .looseObject({
    scenes: z.record(z.string(), sceneReadiness),
    counts: z.record(z.string(), z.number().int()),
  })
  .describe("Each scene's picture (ready, stale, placeholder or missing), voice per line, bed and sound; a placeholder is never ready");

// ── The edit ops ────────────────────────────────────────────────────────────────────────────────

/** A transition out of a scene into the next one. */
export const cutTransition = z.strictObject({
  kind: z.enum(['cut', 'crossfade', 'dip-to-black', 'wipe']),
  durMs: z.number().min(0).describe('At most 2,000 ms and shorter than both scenes, else transition_too_long'),
  direction: z.enum(['from-left', 'from-right', 'from-top', 'from-bottom']).optional().describe("A wipe's direction"),
});

/** The crossfade of the beds into the next scene. */
export const cutBedFade = z.strictObject({ durMs: z.number().gt(0).describe('The bed crossfade into the next scene, in milliseconds') });

const wordTiming = z.strictObject({
  word: z.string(),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  source: z.enum(['whisper', 'tiled']),
});

/** A text layer v1 edits: a strip, an intertitle or a text frame, on the scene's own clock. A capture is not editable. */
export const textLayer = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('strip'),
    text: z.string().min(1).max(2000),
    cite: z.string().max(2000).optional(),
    atMs: z.number().min(0),
    durMs: z.number().gt(0),
    reveal: z.enum(['words', 'none']),
    words: z.array(wordTiming).optional(),
  }),
  z.strictObject({
    kind: z.literal('intertitle'),
    text: z.string().min(1).max(2000),
    atMs: z.number().min(0),
    durMs: z.number().gt(0),
  }),
  z.strictObject({
    kind: z.literal('text-frame'),
    title: z.string().max(2000),
    body: z.string().max(4000),
    atMs: z.number().min(0),
    durMs: z.number().gt(0),
  }),
]);

const assetTable = z
  .record(z.string().min(1).max(200), z.string().min(1).max(1024))
  .describe('A map from an id (no "@") to a file path relative to the film repository, with forward slashes and no . or .. segments');

/** One edit op, as the studio's edit module admits it. */
export const filmEditOp = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('reorder'), sceneIds: z.array(sceneId).min(1).max(2000).describe('The whole order: every scene named once') }),
  z.strictObject({ op: z.literal('move'), sceneId, before: sceneId.nullable().describe('The scene it goes before, or null for the end') }),
  z.strictObject({ op: z.literal('trim'), sceneId, durMs: z.number().int().min(34).describe('The scene length in milliseconds; at least one frame at 30 fps') }),
  z.strictObject({
    op: z.literal('clip_window'),
    sceneId,
    inMs: z.number().min(0).optional().describe("The in point in the normalised clip's own time"),
    outMs: z.number().min(0).optional().describe('The out point, after the in point'),
    speed: z.number().min(0.25).max(4).optional().describe('0.25 to 4; a speed other than 1 needs its normalised copy in the import record (speed_asset_missing)'),
  }),
  z.strictObject({
    op: z.literal('clip_sound'),
    sceneId,
    audio: z.enum(['keep', 'mute']),
    duck: z.boolean().optional(),
    gain: z.number().optional().describe('Decibels'),
  }),
  z.strictObject({
    op: z.literal('transition'),
    sceneId,
    out: cutTransition.nullable().describe('The transition into the next scene, or null for none'),
    bedFade: cutBedFade.nullable().optional().describe('The bed crossfade into the next scene, or null to remove it'),
  }),
  z.strictObject({ op: z.literal('bed'), sceneId, bed: z.string().min(1).max(200).nullable().describe('A key of the beds table, or null for no bed') }),
  z.strictObject({ op: z.literal('beds'), beds: assetTable.describe("The sidecar's beds table") }),
  z.strictObject({
    op: z.literal('marks'),
    sceneId,
    sfx: z.array(z.strictObject({ asset: z.string().min(1).max(200).describe('A key of the marks table'), atMs: z.number().min(0) })).max(500),
  }),
  z.strictObject({ op: z.literal('marks_table'), marks: assetTable.describe("The sidecar's marks table") }),
  z.strictObject({ op: z.literal('layers'), sceneId, layers: z.array(textLayer).max(100).describe("The scene's text layers; they take the place of the text layers it held") }),
]);

/** One edit op, as the studio's edit module admits it. */
export type FilmEditOp = z.infer<typeof filmEditOp>;

// ── The result envelope ─────────────────────────────────────────────────────────────────────────

/** A refusal: the route's code, or the command's, with what the caller needs to decide. */
export const toolError = z.looseObject({
  code: z.string().describe('The refusal code, such as key_missing, engine_missing, stale_write, edit_refused, not_open'),
  message: z.string(),
  status: z.number().int().optional().describe("The route's HTTP status"),
  requestId: z.string().optional(),
  findings: z.array(z.unknown()).optional(),
  sceneId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional().describe("The rest of the route's answer, such as stale_write's current edit times"),
});

/** Every tool answers one object: `{ ok: true, result }` or `{ ok: false, error }`. */
export function toolResult<T extends z.ZodType>(result: T) {
  return z.union([
    z.looseObject({ ok: z.literal(true), result, requestId: z.string().optional(), records: z.array(z.string()).optional() }),
    z.looseObject({ ok: z.literal(false), error: toolError }),
  ]);
}

/** A loose object whose every field is optional: the shapes a route or the command answers today, with room for more. */
function answer<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject(shape).partial();
}

// ── The answers ─────────────────────────────────────────────────────────────────────────────────

const filmSummary = answer({
  filmId: z.string(),
  bookId: z.string(),
  storyboardId: z.string(),
  recordId: z.string(),
  takesId: z.string(),
  title: z.string(),
  importedAtMs: z.number(),
  bundleSha256: z.string(),
  scenes: z.number().int(),
  totalMs: z.number(),
  edited: z.boolean(),
});

const boundDocument = answer({
  importKey: z.string(),
  documentId: z.string(),
  kind: z.string(),
  title: z.string(),
  updatedAtMs: z.number(),
  sourceSha256: z.string(),
  edited: z.boolean(),
});

const sha256Pair = answer({ timeline: z.string().nullable(), sidecar: z.string().nullable() });

const editAnswer = answer({
  seq: z.number().int().nullable(),
  applied: z.number().int(),
  findings: z.array(cutFinding),
  notes: z.array(z.string()),
  sha256: sha256Pair,
  updatedAtMs: z.record(z.string(), z.number()),
  dryRun: z.boolean(),
});

const proposalRights = z.strictObject({
  basis: z.string().min(1).max(200).regex(/\S/).describe('The rights basis, such as own footage, licensed or fair use'),
  holder: z.string().max(200).optional(),
  licence: z.string().max(200).optional(),
  url: z.string().max(2048).optional(),
  attribution: z.string().max(1000).optional(),
});

const proposal = answer({
  proposalId: z.string(),
  filmId: z.string(),
  sceneId: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  rights: z.record(z.string(), z.unknown()),
  assetRef: z.string(),
  by: z.string(),
  submittedAtMs: z.number(),
  status: z.enum(['proposed', 'yes', 'no', 'noted']),
  verdict: answer({ words: z.string(), source: z.enum(['app', 'relayed']), decidedAtMs: z.number() }),
});

const exportSource = answer({
  text: z.string().describe('Left out when the tool wrote the sources into the repository'),
  sha256: z.string(),
  baseSha256: z.string().nullable(),
  changed: z.boolean(),
  notes: z.array(z.unknown()),
});

const SOURCE_NAMES = ['script', 'beatSheet', 'takes', 'timeline', 'sidecar'] as const;
const sourceName = z.enum(SOURCE_NAMES);

/** The names of the sources the export writes back, in the route's order. */
export const EXPORT_SOURCE_NAMES = SOURCE_NAMES;

const engineAnswer = z.looseObject({}).describe("The command's result, passed through as it printed it");

const localPath = (what: string) => filePath.describe(what);
const jobs = z.union([z.number().int().min(1).max(64), z.literal('auto')]).describe('Parallel render jobs, or auto (the default): sized from free memory and cores');

// ── The tools ───────────────────────────────────────────────────────────────────────────────────

/** Each tool's input and output, in the order of the studio's tool surface. */
export const TOOL_SCHEMAS = {
  wildweave_film_list: {
    input: z.strictObject({}),
    output: toolResult(answer({ films: z.array(filmSummary) })),
  },
  wildweave_film_documents: {
    input: z.strictObject({ filmId }),
    output: toolResult(answer({ documents: z.array(boundDocument) })),
  },
  wildweave_film_document_read: {
    input: z.strictObject({ documentId }),
    output: toolResult(
      answer({
        document: answer({
          documentId: z.string(),
          kind: z.string(),
          title: z.string(),
          contentText: z.string(),
          contentJson: z.string(),
          updatedAtMs: z.number(),
          importKey: z.string(),
          sourceSha256: z.string(),
        }),
      }),
    ),
  },
  wildweave_film_timeline: {
    input: z.strictObject({ filmId }),
    output: toolResult(
      answer({
        timeline: z.looseObject({}),
        sidecar: z.looseObject({}).nullable(),
        sha256: sha256Pair,
        updatedAtMs: z.record(z.string(), z.number()),
        readiness,
        recordFormat: z.number().int(),
      }),
    ),
  },
  wildweave_film_scene: {
    input: z.strictObject({ filmId, sceneId }),
    output: toolResult(answer({ scene: z.looseObject({}), sidecar: z.looseObject({}), readiness: sceneReadiness.nullable(), findings: z.array(cutFinding) })),
  },
  wildweave_film_validate: {
    input: z.strictObject({
      filmId: filmId.optional().describe("Validate the account's film in the app (remote); give filmId or cut, not both"),
      cut: localPath('A cut.json on this machine to validate with the local engine').optional(),
      assets: localPath('The film repository the cut reads its files from (local; the film repository by default)').optional(),
      draft: z.boolean().optional().describe('Local: a draft check'),
      strict: z.boolean().optional().describe('Local: warnings count as errors'),
    }),
    output: toolResult(
      answer({
        ok: z.boolean().describe('True when no finding is an error'),
        findings: z.array(cutFinding),
        byScene: z.record(z.string(), z.array(cutFinding)),
        counts: z.record(z.string(), z.number().int()),
        cutSha256: z.string().nullable(),
      }),
    ),
  },
  wildweave_film_edit: {
    input: z.strictObject({
      filmId,
      editId: z.string().min(1).max(128).describe('Your id for this edit; a retry with the same id and ops is applied once, another body with it answers edit_id_reused'),
      ifUpdatedAtMs,
      ops: z.array(filmEditOp).min(1).max(200),
      dryRun: z.boolean().optional().describe('Check the ops and validate without writing'),
    }),
    output: toolResult(editAnswer),
  },
  wildweave_film_edits: {
    input: z.strictObject({ filmId, since: z.number().int().min(0).optional().describe('Rows after this seq; 0 by default') }),
    output: toolResult(
      answer({
        edits: z.array(
          answer({
            seq: z.number().int(),
            kind: z.enum(['edit', 'revert', 'import', 'ack']),
            editId: z.string().nullable(),
            atMs: z.number(),
            by: answer({ accountId: z.string(), keyId: z.string() }),
            ops: z.array(z.unknown()),
            sha256: z.record(z.string(), z.string().nullable()),
          }),
        ),
      }),
    ),
  },
  wildweave_film_revert: {
    input: z.strictObject({
      filmId,
      toSeq: z.number().int().min(1).describe("Put the timeline unit back as it was before this row of the edit log"),
      ifUpdatedAtMs,
      force: z.boolean().optional().describe('Revert across an import row (import_between otherwise); his decision, never a default'),
    }),
    output: toolResult(answer({ seq: z.number().int().nullable(), restored: z.array(z.string()) })),
  },
  wildweave_film_import: {
    input: z.strictObject({
      film: localPath('The film repository; WILDWEAVE_FILM_REPO by default').optional(),
      out: localPath('The folder whose reports/ the import plan and report go to'),
      target: z.enum(['dry-run', 'local', 'production']).describe('dry-run plans and writes nothing; production imports into the account with the studio key'),
      force: z.boolean().optional().describe('Write over documents edited in WildWeave since the import (conflict otherwise); his decision, never a default'),
      exportCheck: z.boolean().optional(),
    }),
    output: toolResult(engineAnswer),
  },
  wildweave_film_export: {
    input: z.strictObject({
      filmId,
      writeTo: localPath('Write the sources into this folder of the film repository (the repository root, or a folder inside it); without it the texts are only returned').optional(),
      force: z.boolean().optional().describe('Write a source whose file changed in the repository since the last crossing (source_changed otherwise); his decision, never a default'),
      paths: z
        .strictObject({
          script: filePath.optional(),
          beatSheet: filePath.optional(),
          takes: filePath.optional(),
          timeline: filePath.optional(),
          sidecar: filePath.optional(),
        })
        .optional()
        .describe("Each source's path relative to writeTo, where the repository keeps it elsewhere than the default layout"),
    }),
    output: toolResult(
      answer({
        recordFormat: z.number().int(),
        sources: z.record(z.string(), exportSource),
        written: z.array(answer({ source: sourceName, path: z.string(), sha256: z.string(), forced: z.boolean() })),
        unchanged: z.array(sourceName),
        validated: z.boolean().describe('True when the local engine cut and validated the written set before it was moved into place'),
        ack: answer({ seq: z.number().int().nullable(), sources: z.record(z.string(), z.unknown()), rebound: z.boolean() }),
      }),
    ),
  },
  wildweave_film_inspect: {
    input: z.strictObject({
      filmId: filmId.optional().describe("Inspect the account's film in the app (remote); give filmId or cut"),
      cut: localPath('A cut.json on this machine').optional(),
      assets: localPath('The film repository the cut reads its files from').optional(),
    }),
    output: toolResult(answer({ report: z.looseObject({}) })),
  },
  wildweave_film_cut: {
    input: z.strictObject({
      timeline: localPath("The timeline; the film repository's production/timeline.json by default").optional(),
      sidecar: localPath("The sidecar; the film repository's production/render.json by default").optional(),
      assets: localPath('The film repository the cut hashes its files under'),
      out: localPath('Where the cut is written, such as production/cut.json'),
      normDir: localPath('The normalised copies folder').optional(),
      takes: localPath('The takes file').optional(),
      draft: z.boolean().optional(),
    }),
    output: toolResult(engineAnswer),
  },
  wildweave_film_strip: {
    input: z.strictObject({
      cut: localPath('The cut.json'),
      assets: localPath('The film repository'),
      out: localPath('The render folder whose strips/ the sheets go to'),
      scene: sceneId.optional().describe('One scene; give scene or all'),
      all: z.boolean().optional().describe('Every scene'),
      frames: z.number().int().min(1).max(64).optional(),
    }),
    output: toolResult(engineAnswer),
  },
  wildweave_film_coverage: {
    input: z.strictObject({ cut: localPath('The cut.json'), assets: localPath('The film repository'), out: localPath('The render folder') }),
    output: toolResult(engineAnswer),
  },
  wildweave_film_render: {
    input: z.strictObject({
      filmId: filmId.optional().describe('Start a render job on the box (remote; answers not_open until the render worker ships)'),
      cut: localPath('The cut.json to render on this machine (local)').optional(),
      assets: localPath('The film repository (local, required with cut)').optional(),
      out: localPath('The render folder (local, required with cut)').optional(),
      kind: z.enum(['draft', 'master', 'strips', 'coverage', 'audio', 'join', 'full']).describe('Local mode renders draft or master; the strip and coverage tools make strips and coverage'),
      jobs: jobs.optional(),
      by: z.enum(['chapter', 'scene', 'duration', 'frames']).optional().describe('How the parts are planned'),
      scene: sceneId.optional().describe("One scene's own part"),
      part: z.string().min(1).max(200).optional().describe('One part'),
      resume: z.boolean().optional(),
      requireStrips: z.boolean().optional().describe("Refuse a render whose strips index does not name the cut's hash"),
      strict: z.boolean().optional().describe('Warnings count as errors'),
    }),
    output: toolResult(answer({ units: z.unknown(), parts: z.unknown(), wallMs: z.number(), jobs: z.unknown(), jobId: z.string(), status: z.string() })),
  },
  wildweave_film_records: {
    input: z.strictObject({
      out: localPath('A render folder on this machine (local)').optional(),
      filmId: filmId.optional().describe('Read a render job on the box (remote, with jobId)'),
      jobId: z.string().min(1).max(200).optional(),
    }),
    output: toolResult(
      answer({
        record: z.unknown(),
        plan: z.unknown(),
        validate: z.unknown(),
        inspect: z.unknown(),
        coverage: z.unknown(),
        strips: z.unknown(),
        preview: z.unknown(),
        run: z.unknown(),
        artifacts: z.array(z.string()),
      }),
    ),
  },
  wildweave_film_preview: {
    input: z.strictObject({ filmId }),
    output: toolResult(
      answer({
        url: z.string().describe("The film's page, where the player plays the preview"),
        readiness,
        files: z.array(
          answer({
            kind: z.enum(['part', 'bed']),
            sceneId: z.string(),
            bedId: z.string(),
            url: z.string(),
            sha256: z.string(),
            bytes: z.number().int(),
            cutSha256: z.string(),
            pushedAtMs: z.number(),
          }),
        ),
        updatedAtMs: z.record(z.string(), z.number()),
        recordFormat: z.number().int(),
      }),
    ),
  },
  wildweave_film_preview_push: {
    input: z.strictObject({
      film: localPath('The film repository; WILDWEAVE_FILM_REPO by default').optional(),
      out: localPath('The render folder whose parts/ the push reads'),
      scenes: z.array(sceneId).min(1).max(500).optional().describe('Only these scenes'),
      beds: z.boolean().optional().describe('Also encode and push the beds'),
      render: z.boolean().optional().describe('Render the draft parts first'),
    }),
    output: toolResult(
      answer({
        filmId: z.string(),
        url: z.string(),
        pushed: z.array(answer({ sceneId: z.string(), sha256: z.string(), bytes: z.number().int(), cutSha256: z.string() })),
        unchanged: z.array(z.string()).describe('Scenes whose part the record holds already'),
        beds: z.array(answer({ bedId: z.string(), sha256: z.string(), bytes: z.number().int(), bitrate: z.string() })),
        bedsUnchanged: z.array(z.string()).describe('Beds whose copy the record holds already'),
        skipped: z.array(
          answer({ kind: z.enum(['part', 'bed']), sceneId: z.string(), bedId: z.string(), reason: z.string(), bytes: z.number().int() }),
        ),
        seq: z.number().int().nullable(),
        readiness,
      }),
    ),
  },
  wildweave_film_proposals: {
    input: z.strictObject({ filmId, status: z.enum(['proposed', 'yes', 'no', 'noted']).optional() }),
    output: toolResult(answer({ proposals: z.array(proposal) })),
  },
  wildweave_film_proposal_submit: {
    input: z.strictObject({
      filmId,
      sceneId,
      kind: z.enum(['clip', 'meme', 'mark', 'split', 'other']),
      title: z.string().min(1).max(200).regex(/\S/),
      body: z.string().max(4000),
      rights: proposalRights,
      assetRef: z.string().min(1).max(1024).optional(),
      by: z.string().min(1).max(64).regex(/\S/).describe('The role proposing it, such as film-memes'),
      proposalId: z
        .string()
        .regex(RFC_9562_UUID)
        .optional()
        .describe("The proposal's id, a UUID; the tool names one when you give none. The same id with the same body answers the proposal that stands (replayed: true) instead of storing a second one; the id under another body answers proposal_id_reused"),
    }),
    output: toolResult(answer({ proposal, replayed: z.boolean().describe('True when the studio held this proposal already: a retry of the same submit, which stored nothing') })),
  },
  wildweave_film_proposal_decide: {
    input: z.strictObject({
      filmId,
      proposalId: z.string().min(1).max(200),
      verdict: z.enum(['yes', 'no', 'note']),
      words: z.string().min(1).max(2000).regex(/\S/).describe('His words, verbatim'),
      source: z.enum(['app', 'relayed']).describe('relayed: the session relays a message of his; app is his own session in the app, refused for a studio key (source_app_needs_session)'),
    }),
    output: toolResult(answer({ proposal })),
  },
} as const;

/** The name of one of the 22 tools. */
export type ToolName = keyof typeof TOOL_SCHEMAS;

/** The names of the 22 tools, in the order of the studio's tool surface. */
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

/** A tool's parsed input. */
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]['input']>;

/**
 * Both schemas of a tool as JSON Schema draft-07: what AgentOS's `ToolExecutor` validates against,
 * what the MCP server lists, and what `dist/schemas/<name>.json` holds.
 */
export function toolJsonSchema(name: ToolName): { input: Record<string, unknown>; output: Record<string, unknown> } {
  const { input, output } = TOOL_SCHEMAS[name];
  return {
    input: z.toJSONSchema(input, { target: 'draft-07', io: 'input' }) as Record<string, unknown>,
    output: z.toJSONSchema(output, { target: 'draft-07', io: 'output' }) as Record<string, unknown>,
  };
}
