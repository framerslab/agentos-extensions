import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOL_SCHEMAS, toolJsonSchema, type ToolName } from '../src/schemas.js';

/** The 22 tools of the studio's tool surface, in its order. */
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
];

/** The committed golden of a tool, or null when the folder holds none yet. */
function golden(name: string): unknown {
  const url = new URL(`./goldens/${name}.json`, import.meta.url);
  return existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : null;
}

describe('the tool schemas', () => {
  it('defines the 22 tools and nothing else', () => {
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
});
