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

/**
 * The transition kinds the cut names (studio v2 spec 4.4): the engine's first four, then a dip to white, a slide, a
 * circle that opens or closes and a diagonal wipe. A kind the render box's ffmpeg lacks is `transition_unsupported`;
 * wildweave_film_templates answers the kinds the box draws.
 */
export const TRANSITION_KINDS = ['cut', 'crossfade', 'dip-to-black', 'wipe', 'dip-to-white', 'slide', 'circle-open', 'circle-close', 'wipe-diagonal'] as const;

/** A transition out of a scene into the next one. */
export const cutTransition = z.strictObject({
  kind: z.enum(TRANSITION_KINDS),
  durMs: z.number().min(0).describe('At most 2,000 ms and shorter than both scenes, else transition_too_long'),
  direction: z
    .enum(['from-left', 'from-right', 'from-top', 'from-bottom', 'from-top-left', 'from-top-right', 'from-bottom-left', 'from-bottom-right'])
    .optional()
    .describe("A wipe's or a slide's side, a diagonal wipe's corner; absent, the kind's default"),
});

/** The crossfade of the beds into the next scene. */
export const cutBedFade = z.strictObject({ durMs: z.number().gt(0).describe('The bed crossfade into the next scene, in milliseconds') });

const wordTiming = z.strictObject({
  word: z.string(),
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  source: z.enum(['whisper', 'tiled']),
});

/** A layer's stable id: unique in its scene, up to 64 characters without the cut's reserved "@". */
const layerId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^@]+$/)
  .describe('A layer\'s stable id, unique in its scene: up to 64 characters without "@"; layer_ids gives one to every layer that lacks it');

/** A text layer v1 edits: a strip, an intertitle or a text frame, on the scene's own clock. A capture is not editable. */
export const textLayer = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('strip'),
    id: layerId.optional(),
    text: z.string().min(1).max(2000),
    cite: z.string().max(2000).optional(),
    atMs: z.number().min(0),
    durMs: z.number().gt(0),
    reveal: z.enum(['words', 'none']),
    words: z.array(wordTiming).optional(),
  }),
  z.strictObject({
    kind: z.literal('intertitle'),
    id: layerId.optional(),
    text: z.string().min(1).max(2000),
    atMs: z.number().min(0),
    durMs: z.number().gt(0),
  }),
  z.strictObject({
    kind: z.literal('text-frame'),
    id: layerId.optional(),
    title: z.string().max(2000),
    body: z.string().max(4000),
    atMs: z.number().min(0),
    durMs: z.number().gt(0),
  }),
]);

const assetTable = z
  .record(z.string().min(1).max(200), z.string().min(1).max(1024))
  .describe('A map from an id (no "@") to a file path relative to the film repository, with forward slashes and no . or .. segments');

// ── The v2 pieces: keyframes, places, moves, templates, sound (studio v2 spec 2.5, 2.6, 4.2, 5.4, 8.2, 8.3) ─────────

const ease = z.enum(['linear', 'smoother', 'hold']).describe('How the segment leaves the point: a straight line, the smoother-step, or held to the next point');

/** One point of an animated value on its target's own clock: whole milliseconds, sorted, inside the target's window. */
function point<T extends z.ZodType>(value: T) {
  return z.strictObject({
    atMs: z.number().min(0).describe("On the target's own clock: whole milliseconds inside its window (keyframe_outside_layer), each after the one before (keyframes_unsorted)"),
    value,
    ease,
  });
}

/** One keyframe of any property, as a `keyframes` op carries it: the value's shape is the property's (an opacity, a gain, a place or a move). */
export const cutKeyframe = point(z.unknown().describe('The property\'s value: an opacity 0 to 1, a gain in dB, a place { xPct, yPct, wPct } or a move { scale, xPct, yPct }'));

const opacityValue = z.number().min(0).max(1).describe('0 (unseen) to 1 (as drawn)');
const opacity = z
  .union([opacityValue, z.array(point(opacityValue)).max(500)])
  .describe("A single opacity held from the layer's start, or its keyframes on the layer's clock");

const placeValue = z
  .strictObject({ xPct: z.number(), yPct: z.number(), wPct: z.number() })
  .describe('Percent of the frame: across and down the room the box leaves, 0 to 100, and the width above 0 and at most 100 (overlay_place_invalid)');
const cutPlace = z.union([placeValue, z.array(point(placeValue)).min(1).max(500)]).describe("A place, or its keyframes on the layer's clock (never an empty list)");

const moveValue = z.strictObject({ scale: z.number().gt(0), xPct: z.number(), yPct: z.number() });
const cutMove = z
  .strictObject({
    fromScale: z.number(),
    toScale: z.number(),
    fromXPct: z.number(),
    fromYPct: z.number(),
    toXPct: z.number(),
    toYPct: z.number(),
    points: z.array(point(moveValue)).max(500).optional().describe("The move's keyframes on its target's clock; with them, the start and the end are not read"),
  })
  .describe('A slow move over a picture: from its start to its end, or through its points');

const gainDb = z.number().describe('Decibels, -30 to +6 (gain_out_of_range otherwise)');
const gainKeyframes = z.array(point(gainDb)).max(500).describe('A gain envelope in dB; with a point, it sets the level in place of gain');
const fadeMs = z.number().int().min(0).describe('Whole milliseconds, at most 5,000 (fade_too_long)');

/** What a `keyframes` op animates (spec 8.3's table): a still's visual, a clip's sound, or a layer by its id. */
export const keyframeTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('visual') }).describe("A still's visual: its move"),
  z.strictObject({ kind: z.literal('clip_sound') }).describe("A clip's sound: its gain"),
  z.strictObject({ kind: z.literal('layer'), layerId }).describe("A layer by its id: a text or template layer's opacity, a capture's or an overlay's move and place, a lower third's place"),
]);

const layerWindow = {
  atMs: z.number().int().min(0).describe("The layer's start on the scene's clock, whole milliseconds"),
  durMs: z.number().int().gt(0).describe('Inside the scene (layer_past_end otherwise)'),
};

const templateRef = z
  .string()
  .min(1)
  .max(200)
  .describe("A registry id such as title.morph, credits.roll or lower-third.band (wildweave_film_templates lists them), or @<id> for an entry of the film's own templates table");
const templateParams = z.unknown().describe("The look's parameters, checked against its schema (template_params_invalid)");

/** A title card, end credits or a lower third from the template registry (spec 4.2): a title or credits sits on a card scene, a lower third on any other. */
export const templateLayer = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('title'), id: layerId, template: templateRef, params: templateParams, ...layerWindow, opacity: opacity.optional() }),
  z.strictObject({ kind: z.literal('credits'), id: layerId, template: templateRef, params: templateParams, ...layerWindow, opacity: opacity.optional() }),
  z.strictObject({ kind: z.literal('lower-third'), id: layerId, template: templateRef, params: templateParams, ...layerWindow, opacity: opacity.optional(), place: cutPlace.optional() }),
]);

/** A picture of the scene's own assets placed over its visual (spec 8.3), named by its id. */
const overlayLayer = z.strictObject({
  id: layerId,
  asset: z.string().min(1).max(128).describe("An image or a clip of the scene's own assets (asset_unknown otherwise; asset_add stages one)"),
  place: cutPlace,
  ...layerWindow,
  opacity: opacity.optional(),
  move: cutMove.optional(),
});

/**
 * What `layer_update` sets on one layer: the fields its kind allows (a text layer's words and timing, a template
 * layer's params, place and timing, an overlay's place, timing, opacity and move, a capture's place and timing); any
 * other field of a layer is layer_field_immutable. null removes an optional field.
 */
const layerFields = z
  .strictObject({
    text: z.string().max(2000).optional(),
    cite: z.string().max(2000).nullable().optional(),
    title: z.string().max(2000).optional(),
    body: z.string().max(4000).optional(),
    atMs: layerWindow.atMs.optional(),
    durMs: layerWindow.durMs.optional(),
    reveal: z.enum(['words', 'none']).optional(),
    words: z.array(wordTiming).nullable().optional(),
    opacity: opacity.nullable().optional(),
    place: cutPlace.nullable().optional(),
    move: cutMove.nullable().optional(),
    params: templateParams.optional(),
    kind: z.unknown().optional().describe('Never set: layer_field_immutable'),
    id: z.unknown().optional().describe('Never set: layer_field_immutable'),
    template: z.unknown().optional().describe('Never set: a layer keeps its look (layer_field_immutable)'),
    asset: z.unknown().optional().describe("Never set: a picture's file is its asset's (layer_field_immutable)"),
    frame: z.unknown().optional().describe('Never set: layer_field_immutable'),
    end: z.unknown().optional().describe('Never set: layer_field_immutable'),
    secondary: z.unknown().optional().describe('Never set: layer_field_immutable'),
    fromMs: z.unknown().optional().describe('Never set: layer_field_immutable'),
    toMs: z.unknown().optional().describe('Never set: layer_field_immutable'),
    fallback: z.unknown().optional().describe('Never set: layer_field_immutable'),
  })
  .describe('The fields to set on the layer');

const bedDuck = z.strictObject({
  depthDb: z.number().describe('-30 to 0 dB'),
  attackMs: z.number().int().min(0),
  releaseMs: z.number().int().min(0),
});

/** What `bed_edit` sets on one run of a bed (spec 5.4): each field, or null to remove it. */
export const bedEdit = z.strictObject({
  inMs: z.number().int().min(0).nullable().optional().describe("Where the run starts inside the bed's file; inside its trusted length (bed_window_invalid, bed_duration_unknown)"),
  outMs: z.number().int().min(0).nullable().optional().describe('Where the run ends inside the file, after inMs'),
  gain: gainDb.nullable().optional(),
  fadeInMs: fadeMs.nullable().optional(),
  fadeOutMs: fadeMs.nullable().optional(),
  duck: bedDuck.nullable().optional().describe('The run\'s own duck under the narration'),
  gainKeyframes: gainKeyframes.nullable().optional(),
});

const stingEntry = z.strictObject({
  asset: z.string().min(1).max(200).describe('A key of the marks table'),
  atMs: z.number().min(0).describe("On the scene's clock, inside the scene"),
  kind: z.enum(['sting', 'mark']).optional(),
  gain: gainDb.optional(),
  fadeInMs: fadeMs.optional(),
  fadeOutMs: fadeMs.optional().describe('Needs durMs: the mix knows where the mark ends from it alone'),
  inMs: z.number().int().min(0).optional().describe('Where in the file it starts'),
  durMs: z.number().int().min(1).optional().describe('How much of the file it plays'),
  gainKeyframes: gainKeyframes.optional(),
});

const assetId = z.string().min(1).max(128).regex(/^[^@]+$/).describe('A timeline asset id of the scene: up to 128 characters without "@"');
const line = z.string().max(500);
const layerIndex = z.number().int().min(0).nullable().optional().describe("Where among the scene's layers it goes, from 0; null or absent puts it last");

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
  // v2 (studio v2 spec 8.2): templates, overlays, layers by their ids, keyframes, sound, studio assets.
  z.strictObject({ op: z.literal('template_layer'), sceneId, at: layerIndex, layer: templateLayer }).describe('Places a title, credits or lower third from the template registry or the film\'s own templates'),
  z
    .strictObject({
      op: z.literal('templates_table'),
      templates: z
        .record(
          z.string().min(1).max(64).regex(/^[^@]+$/),
          z.strictObject({ base: z.string().min(1).max(200).describe('A registry id'), params: templateParams, name: z.string().min(1).max(80).regex(/\S/) }),
        )
        .describe("The film's own templates, whole: a layer names an entry as @<id>; removing one a layer draws is template_in_use"),
    })
    .describe("Writes the sidecar's templates table"),
  z.strictObject({ op: z.literal('overlay'), sceneId, at: layerIndex, overlay: overlayLayer }).describe("Places a picture of the scene's assets over its visual"),
  z.strictObject({ op: z.literal('layer_update'), sceneId, layerId, set: layerFields }).describe('Sets the fields a layer\'s kind allows, on the layer named by its id'),
  z.strictObject({ op: z.literal('layer_remove'), sceneId, layerId }).describe('Takes a text, template or overlay layer off its scene; a capture or a label stays (layer_field_immutable)'),
  z.strictObject({ op: z.literal('layer_ids') }).describe('Gives every layer that lacks one its stable id; nothing a person sees changes'),
  z
    .strictObject({
      op: z.literal('keyframes'),
      sceneId,
      target: keyframeTarget,
      property: z.enum(['move', 'opacity', 'place', 'gain']),
      points: z.array(cutKeyframe).max(500).nullable().describe('The points, or null to remove them and keep the single value'),
    })
    .describe("Sets a property's keyframes on a still's visual (move), a clip's sound (gain) or a layer (opacity, place, move); a bed run's and a mark's gain are bed_edit's and sting's"),
  z.strictObject({ op: z.literal('bed_edit'), run: sceneId.describe("The run, named by the id of its first scene"), edit: bedEdit }).describe('Sets one run of a bed: trim, level, fades, duck and envelope'),
  z.strictObject({ op: z.literal('sting'), sceneId, sfx: z.array(stingEntry).max(500).describe("The scene's whole marks list") }).describe("Writes a scene's marks and stings with their level, fades, part of the file and envelope"),
  z
    .strictObject({
      op: z.literal('asset_add'),
      sceneId,
      assetId,
      assetRow: z.string().min(1).max(200).describe("The account's staged file (wildweave_film_assets row): its kind, path, licence and rights are read from it, never from the op"),
      note: line.optional(),
      changes: line.optional().describe('The changes line of the rights credit, such as "cropped to 16:9"'),
    })
    .describe("Adds a staged studio file to the scene's assets; a file outside the licences a film takes is asset_not_eligible"),
  z.strictObject({ op: z.literal('asset_remove'), sceneId, assetId }).describe('Takes an asset off the scene; one a visual, an overlay, a bed or a mark names is asset_in_use'),
  z
    .strictObject({ op: z.literal('visual'), sceneId, asset: assetId.nullable().describe("A still or a clip of the scene's assets, or null for the scene's default"), move: cutMove.nullable().optional() })
    .describe("Sets the scene's picture and its move"),
  z
    .strictObject({ op: z.literal('assets_rights'), entries: z.record(assetId, z.strictObject({ changes: line })).describe("Each timeline asset's changes line alone; no op sets a rights value") })
    .describe("Writes the changes line of the assets' rights credits"),
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
  refusal: z
    .looseObject({
      capability: z.string(),
      tier: z.string(),
      requiredPlan: z.string().nullable(),
      upgradeUrl: z.string(),
      limit: z.looseObject({}),
      checkoutPaused: z.boolean(),
      policyVersion: z.number().int(),
    })
    .partial()
    .optional()
    .describe("The gate's envelope beside the code: the account's plan or room decides it, so the call is never sent again as it is"),
});

/**
 * The codes of the studio gate's one refusal envelope (studio v2 spec, the Amendment's A.7): what the account's plan,
 * its room or the policy decides, each with the policy module's words in `message`. A plan or a room never changes on a
 * retry, so the client never sends a call refused with one of these again; `rate_limited` waits out its Retry-After.
 */
export const STUDIO_REFUSAL_CODES = [
  'sign_in_required',
  'forge_required',
  'plan_required',
  'limit_reached',
  'insufficient_credits',
  'budget_exhausted',
  'not_open',
  'file_too_large',
  'rate_limited',
  'key_rejected',
  'scope_required',
  'source_app_needs_session',
  'demo_not_ready',
] as const;

/**
 * The studio gate's one refusal envelope (the Amendment's A.7): the code in `error`, the capability and the tier it
 * was refused for, the lowest plan that opens it, where to upgrade, the meter a room refusal names, whether checkout is
 * paused, the policy's version and its words. Every field but `error` is optional and a later field is kept, so a v1
 * body that names the code alone (`{ error: 'forge_required' }`) still parses.
 */
export const StudioRefusal = z
  .looseObject({
    error: z.string().min(1).describe('The refusal code, such as plan_required or limit_reached'),
    capability: z.string().optional().describe('The capability key refused, such as edit.keyframes'),
    tier: z.string().optional().describe("The caller's identity: visitor, free, plus, pro or forge"),
    requiredPlan: z.string().nullable().optional().describe('The lowest plan that opens the capability (free, plus, pro or forge), or null'),
    upgradeUrl: z.string().optional().describe('Where the account holder upgrades, such as /pricing'),
    limit: z
      .looseObject({ meter: z.string(), used: z.number(), max: z.number(), window: z.string(), resetsAt: z.number().optional() })
      .optional()
      .describe('The meter a room refusal names: what is used of what, over which window, and when it resets'),
    checkoutPaused: z.boolean().optional(),
    policyVersion: z.number().int().optional(),
    message: z.string().optional().describe("The policy module's words for the refusal, the sentence the person reads"),
  })
  .describe("The studio gate's refusal envelope");

/** The studio gate's refusal envelope, parsed. */
export type StudioRefusal = z.infer<typeof StudioRefusal>;

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

/** One staged file the export route lists for the repository (spec 8.4): fetched through the files route and written at its path. */
const exportFetchEntry = answer({
  path: z.string().describe('The repository path the file is written at'),
  sha256: z.string(),
  bytes: z.number().int(),
  url: z.string().describe("The files route's address of the file under the account's own folder"),
  rights: z.looseObject({}).describe('The rights line the file carries: licence, its id and URL, attribution, rights, changes, notice, source'),
  stockJson: z.string().describe("The librarian's record, written beside the file as stock.json"),
  line: answer({ sceneId: z.string(), index: z.number().int() }).describe("A generated take's line"),
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
        fetch: z.array(exportFetchEntry).describe('Without writeTo: the staged files the timeline names that the repository does not hold yet, as the route lists them'),
        fetched: z
          .array(answer({ path: z.string(), sha256: z.string(), bytes: z.number().int(), stock: z.string().describe('Where its stock.json was written'), forced: z.boolean() }))
          .describe('With writeTo: each staged file fetched, checked by its sha256 and written at its path'),
        fetchUnchanged: z.array(z.string()).describe('With writeTo: each listed path the repository already held with the same sha256, never fetched'),
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
  wildweave_film_templates: {
    input: z.strictObject({ filmId: filmId.optional().describe("Also read this film's own templates table") }),
    output: toolResult(
      answer({
        definitions: z
          .array(
            answer({
              id: z.string().describe('The look\'s id, such as title.morph, the template a layer names'),
              kind: z.enum(['title', 'credits', 'lower-third', 'transition']),
              name: z.string(),
              editable: z.unknown().describe('The groups of the look a person edits: type, colours, motion, timing, content'),
              defaults: z.unknown(),
              params: z.looseObject({}).describe("The parameters' schema, as JSON Schema"),
              thumbnailAtMs: z.number(),
            }),
          )
          .describe("The template registry's definitions"),
        transitions: z.array(z.string()).describe('The transition kinds the render box draws'),
        saved: z
          .array(answer({ templateId: z.string(), base: z.string(), params: z.unknown(), name: z.string(), createdAtMs: z.number(), updatedAtMs: z.number() }))
          .describe("The account's saved templates, where its plan authors them; none otherwise"),
        film: answer({ filmId: z.string(), templates: z.record(z.string(), z.unknown()) }).describe("With filmId: the film's own templates table"),
      }),
    ),
  },
} as const;

/** The name of one of the 23 tools. */
export type ToolName = keyof typeof TOOL_SCHEMAS;

/** The names of the 23 tools, in the order of the studio's tool surface. */
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
