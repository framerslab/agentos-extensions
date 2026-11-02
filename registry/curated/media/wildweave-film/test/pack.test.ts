import type { ExtensionPack, ITool } from '@framers/agentos';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import createDefault, { createExtensionPack, type WildweaveFilmPack, type WildweaveFilmTool } from '../src/index.js';
import { TOOL_NAMES } from '../src/schemas.js';
import { FAKE_KEY, FILM_ID, LOCAL_SAMPLES, REMOTE_SAMPLES, SAMPLE_ARGS, fixture, startFakeStudio, type FakeStudio } from './helpers.js';

// The pack's own shapes are structural: a tool is AgentOS's ITool and the pack its ExtensionPack, checked at compile time.
type Assignable<T, U> = T extends U ? true : false;
const toolIsITool: Assignable<WildweaveFilmTool, ITool> = true;
const packIsExtensionPack: Assignable<WildweaveFilmPack, ExtensionPack> = true;

const VARIABLES = ['WILDWEAVE_STUDIO_KEY', 'WILDWEAVE_STUDIO_BASE_URL', 'WILDWEAVE_FILM_ENGINE_DIR', 'WILDWEAVE_FILM_REPO', 'WILDWEAVE_FILM_LOG_LEVEL', 'WILDWEAVE_FILM_TIMEOUT_MS'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const name of VARIABLES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const quiet = { write: () => undefined };

function toolOf(pack: WildweaveFilmPack, name: string): WildweaveFilmTool {
  const descriptor = pack.descriptors.find((d) => d.id === name);
  if (!descriptor) throw new Error(`the pack lists no ${name}`);
  return descriptor.payload;
}

describe('the AgentOS pack', () => {
  it('is an ExtensionPack of ITools', () => {
    expect(toolIsITool && packIsExtensionPack).toBe(true);
  });

  it('loads with no key and no engine, and lists the 22 tools, each descriptor id its tool name', async () => {
    const pack = await createExtensionPack({ options: {}, logDestination: quiet });
    expect(pack.name).toBe('@framers/agentos-ext-wildweave-film');
    expect(pack.descriptors.map((d) => d.id)).toEqual(TOOL_NAMES);
    for (const d of pack.descriptors) {
      expect(d.kind).toBe('tool');
      expect(d.priority).toBe(30);
      expect(d.payload.name).toBe(d.id);
      expect(d.payload.id).toBe(`com.framers.media.wildweave-film.${d.id.replace('wildweave_film_', '').replace(/_/g, '-')}`);
      expect(d.payload.category).toBe('media');
      expect(d.payload.inputSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(d.payload.outputSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(d.requiredSecrets?.every((s) => s.optional === true) ?? true).toBe(true);
    }
    expect(toolOf(pack, 'wildweave_film_edit').hasSideEffects).toBe(true);
    expect(toolOf(pack, 'wildweave_film_timeline').hasSideEffects).toBe(false);
    await pack.onActivate();
    await pack.onDeactivate();
  });

  it('is the module default export too', async () => {
    expect(createDefault).toBe(createExtensionPack);
  });

  it.each(REMOTE_SAMPLES)('%s answers key_missing without a key', async (name) => {
    const pack = await createExtensionPack({ logDestination: quiet });
    const result = await toolOf(pack, name).execute(SAMPLE_ARGS[name]);
    expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'key_missing' } } });
  });

  it.each(LOCAL_SAMPLES)('%s answers engine_missing without an engine', async (name) => {
    const pack = await createExtensionPack({ logDestination: quiet });
    const result = await toolOf(pack, name).execute(SAMPLE_ARGS[name]);
    expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'engine_missing' } } });
  });

  it('answers arg_invalid, naming the field, for arguments its schema refuses', async () => {
    const pack = await createExtensionPack({ logDestination: quiet });
    const result = await toolOf(pack, 'wildweave_film_edit').execute({ ...SAMPLE_ARGS.wildweave_film_edit, ops: [{ op: 'clip_window', sceneId: 's03', speed: 9 }] });
    expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'arg_invalid' } } });
    expect(result.error).toContain('ops.0');
  });

  it('reads the key from the secret reader before the environment', async () => {
    process.env.WILDWEAVE_STUDIO_KEY = 'wld_live_from_the_environment';
    const studio = await startFakeStudio();
    try {
      const pack = await createExtensionPack({ options: { baseUrl: studio.baseUrl }, getSecret: (id) => (id === 'wildweave.studio.key' ? FAKE_KEY : undefined), logDestination: quiet });
      expect((await toolOf(pack, 'wildweave_film_list').execute({})).success).toBe(true);
      expect(studio.requests[0]!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    } finally {
      await studio.close();
    }
  });

  describe('against a fake studio', () => {
    let studio: FakeStudio;
    beforeEach(async () => {
      studio = await startFakeStudio();
    });
    afterEach(async () => {
      await studio.close();
    });

    it("lists the fixture's film", async () => {
      const pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl }, logDestination: quiet });
      const result = await toolOf(pack, 'wildweave_film_list').execute({});
      expect(result).toMatchObject({ success: true, output: { ok: true, result: fixture('films') } });
    });

    it('passes a 422 edit_refused through with its findings', async () => {
      const pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl }, logDestination: quiet });
      const result = await toolOf(pack, 'wildweave_film_edit').execute({ ...SAMPLE_ARGS.wildweave_film_edit, ops: [{ op: 'trim', sceneId: 's02', durMs: 3000 }] });
      const refused = fixture<{ findings: unknown[] }>('edit-refused');
      expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'edit_refused', status: 422, findings: refused.findings } } });
      const edit = studio.requests.find((r) => r.path === `/films/${FILM_ID}/edits`);
      expect(edit!.body).toEqual({ editId: 'edit-1', ifUpdatedAtMs: { 'demo:timeline:film': 1 }, ops: [{ op: 'trim', sceneId: 's02', durMs: 3000 }] });
    });

    it('answers a render job on the box with not_open', async () => {
      const pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl }, logDestination: quiet });
      const result = await toolOf(pack, 'wildweave_film_render').execute({ filmId: FILM_ID, kind: 'draft' });
      expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'not_open', status: 503 } } });
    });

    it('logs each call with its tool, mode and request id, and never the key', async () => {
      const collected: string[] = [];
      const pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl }, logDestination: { write: (line: string) => void collected.push(line) } });
      await toolOf(pack, 'wildweave_film_preview').execute({ filmId: FILM_ID });
      await toolOf(pack, 'wildweave_film_timeline').execute({ filmId: 'film-unknown' });
      const calls = collected.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.event === 'wildweave_film.call');
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ tool: 'wildweave_film_preview', mode: 'remote', ok: true, requestId: 'req-200', module: 'wildweave-film-mcp' });
      expect(calls[1]).toMatchObject({ tool: 'wildweave_film_timeline', ok: false, code: 'not_found' });
      expect(collected.join('\n')).not.toContain(FAKE_KEY);
    });
  });
});
