import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import * as schemas from '../src/schemas.js';
import { TOOL_SCHEMAS, toolJsonSchema, type ToolName } from '../src/schemas.js';

/** The 23 tools of the studio's tool surface, in its order. */
const TOOL_NAMES: ToolName[] = [
  'wildweave_film_list',
  'wildweave_film_documents',
  'wildweave_film_document_read',
  'wildweave_film_timeline',
  'wildweave_film_scene',
  'wildweave_film_validate',
  'wildweave_film_edit',
  'wildweave_film_edits',
  'wildweave_film_revert',
  'wildweave_film_import',
  'wildweave_film_export',
  'wildweave_film_inspect',
  'wildweave_film_cut',
  'wildweave_film_strip',
  'wildweave_film_coverage',
  'wildweave_film_render',
  'wildweave_film_records',
  'wildweave_film_preview',
  'wildweave_film_preview_push',
  'wildweave_film_proposals',
  'wildweave_film_proposal_submit',
  'wildweave_film_proposal_decide',
  'wildweave_film_templates' as string as ToolName,
];

/** The committed golden of a tool, or null when the folder holds none yet. */
function golden(name: string): unknown {
  const url = new URL(`./goldens/${name}.json`, import.meta.url);
  return existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : null;
}

describe('the tool schemas', () => {
  it('defines the 23 tools and nothing else', () => {
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  // The goldens are the JSON Schemas (draft-07) a host reads: AgentOS's ToolExecutor and the MCP tools/list. A change
  // to a schema shows as a diff of its golden. A golden that is missing or differs fails, and the line printed holds
  // the schema as built, so a reviewer reads the change in the run's log before it is committed.
  it.each(TOOL_NAMES)('%s: the JSON Schema golden matches', (name) => {
    const built = toolJsonSchema(name);
    const committed = golden(name);
    if (JSON.stringify(committed) !== JSON.stringify(built)) console.log(`GOLDEN_ACTUAL ${name} ${JSON.stringify(built)}`);
    expect(committed).toEqual(built);
  });

  it('writes every schema as JSON Schema draft-07', () => {
    for (const name of TOOL_NAMES) {
      const { input, output } = toolJsonSchema(name);
      expect((input as { $schema?: string }).$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect((output as { $schema?: string }).$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect((input as { type?: string }).type).toBe('object');
    }
  });

  it("accepts an edit body and refuses a speed outside 0.25 to 4", () => {
    const edit = TOOL_SCHEMAS.wildweave_film_edit.input;
    const times = { 'demo:timeline:film': 1, 'demo:timeline:storyboard': 2, 'demo:timeline:record': 3 };
    expect(edit.safeParse({ filmId: 'f', editId: 'e1', ifUpdatedAtMs: times, ops: [{ op: 'trim', sceneId: 's02', durMs: 8000 }] }).success).toBe(true);
    expect(edit.safeParse({ filmId: 'f', editId: 'e1', ifUpdatedAtMs: times, ops: [{ op: 'clip_window', sceneId: 's03', speed: 9 }] }).success).toBe(false);
  });

  it('takes the text layers the edit module admits, and refuses a capture', () => {
    const edit = TOOL_SCHEMAS.wildweave_film_edit.input;
    const layers = (layer: unknown) => ({ filmId: 'f', editId: 'e2', ifUpdatedAtMs: { a: 1 }, ops: [{ op: 'layers', sceneId: 's01', layers: [layer] }] });
    expect(edit.safeParse(layers({ kind: 'strip', text: 'A strip', atMs: 0, durMs: 1000, reveal: 'none' })).success).toBe(true);
    expect(edit.safeParse(layers({ kind: 'intertitle', text: 'Later', atMs: 0, durMs: 1000 })).success).toBe(true);
    expect(edit.safeParse(layers({ kind: 'text-frame', title: 'A title', body: 'A body', atMs: 0, durMs: 1000 })).success).toBe(true);
    expect(edit.safeParse(layers({ kind: 'capture', src: 'a.png', atMs: 0, durMs: 1000 })).success).toBe(false);
  });

  it('refuses a field the tool does not name, so a misspelt one is not dropped', () => {
    const submit = TOOL_SCHEMAS.wildweave_film_proposal_submit.input;
    const base = { filmId: 'f', sceneId: 's01', kind: 'clip', title: 'A clip', body: '', rights: { basis: 'own footage' }, by: 'film-editor' };
    expect(submit.safeParse(base).success).toBe(true);
    expect(submit.safeParse({ ...base, rights: { basis: 'own footage', license: 'CC-BY' } }).success).toBe(false);
    expect(submit.safeParse({ ...base, asset_ref: 'x' }).success).toBe(false);
    expect(submit.safeParse({ ...base, title: '   ' }).success).toBe(false);
  });

  it('takes the proposalId the route takes: an RFC 9562 UUID, not any 8-4-4-4-12 hex', () => {
    const submit = TOOL_SCHEMAS.wildweave_film_proposal_submit.input;
    const base = { filmId: 'f', sceneId: 's01', kind: 'clip', title: 'A clip', body: '', rights: { basis: 'own footage' }, by: 'film-editor' };
    expect(submit.safeParse({ ...base, proposalId: '7d0f3c2a-5b1e-4c8d-9a6f-2e4b8c0d1a3f' }).success).toBe(true);
    // Hex in every place, but its variant digit is 1: the route's z.uuid() answers 400 invalid_body for it.
    expect(submit.safeParse({ ...base, proposalId: '12345678-1234-1234-1234-123456789abc' }).success).toBe(false);
  });
});

/** An edit body of one or more ops. */
const editBody = (ops: unknown[]) => ({ filmId: 'f', editId: 'e-v2', ifUpdatedAtMs: { a: 1 }, ops });

const fade = (from: number, to: number) => [
  { atMs: 0, value: from, ease: 'smoother' },
  { atMs: 1000, value: to, ease: 'linear' },
];
const PLACE = { xPct: 80, yPct: 10, wPct: 30 };
const MOVE = { fromScale: 1, toScale: 1.2, fromXPct: 50, fromYPct: 50, toXPct: 40, toYPct: 60 };

/** One of each op the edit module on wilds.ai master admits beyond v1's (studio v2 spec 8.2), in the shapes it reads. */
const V2_OPS: Array<Record<string, unknown>> = [
  { op: 'template_layer', sceneId: 's03', at: null, layer: { kind: 'title', id: 'title-1', template: 'title.serif', params: { lines: ['Morning'] }, atMs: 0, durMs: 4000, opacity: fade(0, 1) } },
  { op: 'template_layer', sceneId: 's03', at: 0, layer: { kind: 'credits', id: 'credits-1', template: '@my-credits', params: {}, atMs: 0, durMs: 6000 } },
  { op: 'template_layer', sceneId: 's02', layer: { kind: 'lower-third', id: 'lt-1', template: 'lower-third.band', params: { name: 'The keeper' }, atMs: 500, durMs: 3000, place: PLACE } },
  { op: 'templates_table', templates: { 'my-credits': { base: 'credits.roll', params: { linesPerSecond: 1 }, name: 'Our credits' } } },
  { op: 'overlay', sceneId: 's01', at: null, overlay: { id: 'ov-1', asset: 'gull-still', place: [{ atMs: 0, value: PLACE, ease: 'linear' }, { atMs: 2000, value: { xPct: 20, yPct: 10, wPct: 30 }, ease: 'hold' }], atMs: 0, durMs: 2000, opacity: 0.8, move: { ...MOVE, points: [{ atMs: 0, value: { scale: 1, xPct: 50, yPct: 50 }, ease: 'smoother' }] } } },
  { op: 'layer_update', sceneId: 's01', layerId: 'ov-1', set: { place: PLACE, atMs: 200, durMs: 1500, opacity: null } },
  { op: 'layer_update', sceneId: 's03', layerId: 'title-1', set: { params: { lines: ['Dawn'] } } },
  { op: 'layer_remove', sceneId: 's01', layerId: 'ov-1' },
  { op: 'layer_ids' },
  { op: 'keyframes', sceneId: 's01', target: { kind: 'visual' }, property: 'move', points: [{ atMs: 0, value: { scale: 1, xPct: 50, yPct: 50 }, ease: 'linear' }] },
  { op: 'keyframes', sceneId: 's01', target: { kind: 'clip_sound' }, property: 'gain', points: fade(-12, 0) },
  { op: 'keyframes', sceneId: 's03', target: { kind: 'layer', layerId: 'title-1' }, property: 'opacity', points: null },
  { op: 'bed_edit', run: 's01', edit: { inMs: 1000, outMs: 9000, gain: -3, fadeInMs: 400, fadeOutMs: null, duck: { depthDb: -12, attackMs: 120, releaseMs: 600 }, gainKeyframes: fade(-6, 0) } },
  { op: 'sting', sceneId: 's02', sfx: [{ asset: 'gull', atMs: 1200, kind: 'sting', gain: -2, fadeInMs: 50, fadeOutMs: 200, inMs: 0, durMs: 900, gainKeyframes: fade(0, -6) }, { asset: 'bell', atMs: 4000 }] },
  { op: 'asset_add', sceneId: 's02', assetId: 'harbour-clip', assetRow: 'row-7f3a', note: 'the harbour at night', changes: 'cropped to 16:9' },
  { op: 'asset_remove', sceneId: 's02', assetId: 'harbour-clip' },
  { op: 'visual', sceneId: 's02', asset: 'harbour-clip', move: MOVE },
  { op: 'visual', sceneId: 's02', asset: null, move: null },
  { op: 'assets_rights', entries: { 'harbour-clip': { changes: 'cropped to 16:9' } } },
  { op: 'transition', sceneId: 's01', out: { kind: 'wipe-diagonal', durMs: 600, direction: 'from-top-left' } },
  { op: 'transition', sceneId: 's02', out: { kind: 'circle-open', durMs: 500 } },
  { op: 'layers', sceneId: 's01', layers: [{ kind: 'strip', id: 'strip-1', text: 'A strip', atMs: 0, durMs: 1000, reveal: 'none' }] },
];

describe('the v2 edit ops', () => {
  const edit = TOOL_SCHEMAS.wildweave_film_edit.input;

  it.each(V2_OPS.map((op, i): [string, Record<string, unknown>] => [`${String(op.op)} (case ${i + 1})`, op]))('takes %s', (_label, op) => {
    const parsed = edit.safeParse(editBody([op]));
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it('takes every v2 op in one edit', () => {
    expect(edit.safeParse(editBody(V2_OPS)).success).toBe(true);
  });

  it('refuses a keyframes op with a property it does not name, a property outside its four, and a point without its ease', () => {
    const keyframes = { op: 'keyframes', sceneId: 's01', target: { kind: 'visual' }, property: 'move', points: null };
    expect(edit.safeParse(editBody([keyframes])).success).toBe(true);
    expect(edit.safeParse(editBody([{ ...keyframes, curve: 'ease-in' }])).success).toBe(false);
    expect(edit.safeParse(editBody([{ ...keyframes, property: 'scale' }])).success).toBe(false);
    expect(edit.safeParse(editBody([{ ...keyframes, points: [{ atMs: 0, value: 1 }] }])).success).toBe(false);
    expect(edit.safeParse(editBody([{ ...keyframes, target: { kind: 'layer' } }])).success).toBe(false);
  });

  it('refuses a rights field on asset_add, an overlay that names its kind, a layer id holding "@" and a template entry with no name', () => {
    expect(edit.safeParse(editBody([{ op: 'asset_add', sceneId: 's02', assetId: 'a', assetRow: 'r', licence: 'CC BY 4.0' }])).success).toBe(false);
    expect(edit.safeParse(editBody([{ op: 'overlay', sceneId: 's01', overlay: { kind: 'overlay', id: 'o', asset: 'a', place: PLACE, atMs: 0, durMs: 1000 } }])).success).toBe(false);
    expect(edit.safeParse(editBody([{ op: 'layer_remove', sceneId: 's01', layerId: 'a@b' }])).success).toBe(false);
    expect(edit.safeParse(editBody([{ op: 'templates_table', templates: { mine: { base: 'title.serif', params: {} } } }])).success).toBe(false);
  });

  it('keeps the preview push\'s own op out of the edit tool', () => {
    expect(edit.safeParse(editBody([{ op: 'preview_media', scenes: {}, keyEnv: {} }])).success).toBe(false);
  });
});

describe('the refusal envelope', () => {
  const envelope = (schemas as unknown as Record<string, ZodType | undefined>).StudioRefusal;

  it('parses a v1 { error } body, so a route that answers the code alone still reads as a refusal', () => {
    expect(envelope).toBeDefined();
    expect(envelope!.safeParse({ error: 'forge_required' }).success).toBe(true);
    expect(envelope!.safeParse({ message: 'no code' }).success).toBe(false);
  });

  it('parses the whole envelope, and a field a later release adds', () => {
    expect(envelope).toBeDefined();
    const whole = {
      error: 'plan_required',
      capability: 'edit.keyframes',
      tier: 'plus',
      requiredPlan: 'pro',
      upgradeUrl: '/pricing',
      limit: { meter: 'films', used: 3, max: 3, window: 'account' },
      checkoutPaused: false,
      policyVersion: 2,
      message: 'Keyframes are part of Pro.',
      index: 0,
    };
    expect(envelope!.safeParse(whole).success).toBe(true);
  });
});
