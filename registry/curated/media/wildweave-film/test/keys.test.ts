/**
 * End to end over the real path: the studio key never reaches a log line or an error. The key is
 * configured as a value of the studio key's shape and as a value of another shape (masked as the
 * configured secret, not by its shape). The studio echoes the bearer into every refusal it answers; the
 * engine prints the token it was given on stderr and in its answer; every tool is called through the
 * AgentOS pack and through the MCP server, with the pack's logger at debug and its lines captured.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExtensionPack, createToolContext, resolveConfig, type WildweaveFilmPack } from '../src/index.js';
import { createLogger } from '../src/log.js';
import { createWildweaveMcpServer } from '../src/mcp/index.js';
import { TOOL_NAMES, type ToolName } from '../src/schemas.js';
import { FAKE_KEY, SAMPLE_ARGS, engineStub, startScriptedStudio, type ScriptedStudio } from './helpers.js';

/** A key of another shape than the studio's, synthetic: masked because it is the configured key. */
const OTHER_SHAPE_KEY = 'synthetic-key-7f3a9c2e5b1d4f6a8c0e';

/** Each tool's arguments: the samples, with the import sent to production so its child is given the key. */
const ARGS: Record<ToolName, Record<string, unknown>> = { ...SAMPLE_ARGS, wildweave_film_import: { ...SAMPLE_ARGS.wildweave_film_import, target: 'production' } };

/** The variables a parent could leak to the engine's child; each is set to the key while a test runs. */
const KEY_VARIABLES = ['WILDWEAVE_STUDIO_KEY', 'WILDS_IMPORT_TOKEN'] as const;

let studio: ScriptedStudio;
let scratch: string;
let engineDir: string;
const saved: Partial<Record<(typeof KEY_VARIABLES)[number], string>> = {};

beforeAll(async () => {
  studio = await startScriptedStudio();
  scratch = mkdtempSync(join(tmpdir(), 'wildweave-film-keys-'));
  engineDir = join(scratch, 'engine');
  mkdirSync(engineDir);
});
afterAll(async () => {
  await studio?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  studio.requests.length = 0;
  for (const name of KEY_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined) saved[name] = value;
  }
});
afterEach(() => {
  for (const name of KEY_VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
    delete saved[name];
  }
});

/** A studio that refuses every call, quoting the bearer it was sent in the message and in the rest of its answer. */
function echoingStudio(): void {
  studio.answer = (request) => {
    const bearer = request.authorization ?? '';
    const key = bearer.replace(/^Bearer /, '');
    return { status: 400, body: { error: 'invalid_body', message: `refused the header ${bearer}`, header: bearer, seen: { key, note: `the key was ${key}` } } };
  };
}

/** An engine that prints the token it was given, and the studio key if a parent leaked it, on stderr and in its answer. */
function echoingEngine() {
  return engineStub((call) => {
    const token = call.env.WILDS_IMPORT_TOKEN ?? '-';
    const leaked = call.env.WILDWEAVE_STUDIO_KEY ?? '-';
    return {
      stdout: `${JSON.stringify({ ok: false, error: { code: 'engine_said', message: `the token was ${token}`, details: { token, leaked, note: `token ${token} leaked ${leaked}` } } })}\n`,
      stderr: `child token ${token}\nchild studio key ${leaked}\n`,
      exitCode: 1,
    };
  });
}

describe('the studio key, in every log line and every answer', () => {
  it.each([
    ['of the studio key shape', FAKE_KEY],
    ['of another shape', OTHER_SHAPE_KEY],
  ])('a key %s never reaches a log line, an answer or an error, through either host', async (_shape, key) => {
    for (const name of KEY_VARIABLES) process.env[name] = key;
    echoingStudio();
    const engine = echoingEngine();
    const lines: string[] = [];
    const destination = { write: (line: string) => void lines.push(line) };
    const answers: string[] = [];
    const options = { key, baseUrl: studio.baseUrl, engineDir, filmRepo: join(scratch, 'film'), logLevel: 'debug' };

    // The AgentOS host.
    const pack: WildweaveFilmPack = await createExtensionPack({ options, logDestination: destination, deps: { execFile: engine.execFile } });
    await pack.onActivate();
    for (const descriptor of pack.descriptors) {
      const result = await descriptor.payload.execute(ARGS[descriptor.payload.name as ToolName]);
      answers.push(JSON.stringify(result));
    }

    // The MCP host, its server built as the bin builds it, with the same kind of logger.
    const config = await resolveConfig(options, undefined, {});
    const log = createLogger({ level: config.logLevel, secrets: config.key ? [config.key] : [], destination });
    const ctx = createToolContext(config, log, { execFile: engine.execFile });
    const handler = createMcpHandler(() => createWildweaveMcpServer(config, log, ctx));
    const client = new Client({ name: 'wildweave-film-keys', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL('http://mcp.test.invalid/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
    try {
      for (const name of TOOL_NAMES) answers.push(JSON.stringify(await client.callTool({ name, arguments: ARGS[name] })));
    } finally {
      await client.close();
      await handler.close();
    }

    // Every call ran: the studio took each remote call from both hosts, and the engine each local run.
    const events = lines.map((line) => (JSON.parse(line) as { event?: string }).event);
    expect(events.filter((e) => e === 'wildweave_film.call')).toHaveLength(TOOL_NAMES.length * 2);
    expect(events).toContain('wildweave_film.refused');
    expect(events).toContain('wildweave_film.engine_run');
    expect(events).toContain('wildweave_film.engine_stderr');
    expect(studio.requests.every((r) => r.authorization === `Bearer ${key}`)).toBe(true);
    expect(engine.calls.length).toBeGreaterThan(0);
    // A child that needs no key gets none, though the parent holds both variables.
    for (const call of engine.calls) {
      expect(call.env.WILDWEAVE_STUDIO_KEY).toBeUndefined();
      if (!['import', 'preview'].includes(call.argv[1]!)) expect(call.env.WILDS_IMPORT_TOKEN).toBeUndefined();
    }
    // The echoes happened, and were masked.
    expect(answers.join('\n')).toContain('[redacted]');
    expect(lines.join('\n')).not.toContain(key);
    for (const answer of answers) expect(answer).not.toContain(key);
  });

  // A refusal's findings reach the model as they are: an edit's finding can quote a text layer's words, and a key
  // pasted into one comes back in it. The spec masks a key's shape in every error the tools return (section 3.5).
  it("masks a key in a refusal's findings, which the answer carries to the model", async () => {
    const quoted = `the strip "${FAKE_KEY}" runs past the frame`;
    studio.answer = () => ({ status: 422, body: { error: 'edit_refused', findings: [{ level: 'error', code: 'layer_overflow', sceneId: 's02', message: quoted }] } });
    const pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl }, logDestination: { write: () => undefined } });
    const edit = pack.descriptors.find((d) => d.id === 'wildweave_film_edit')!.payload;
    const result = await edit.execute(SAMPLE_ARGS.wildweave_film_edit);
    expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'edit_refused', status: 422, findings: [{ code: 'layer_overflow', sceneId: 's02' }] } } });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });

  // The masking walks eight levels down; a key below them, in a finding or in the refusal's other fields, came back
  // as it was.
  it("masks a key nested deeper than the masking walks, in a refusal's findings and its details", async () => {
    let deep: unknown = `quoted ${FAKE_KEY}`;
    for (let i = 0; i < 12; i++) deep = { level: deep };
    studio.answer = () => ({ status: 422, body: { error: 'edit_refused', findings: [{ code: 'layer_overflow', sceneId: 's02', where: deep }], context: deep } });
    const pack = await createExtensionPack({ options: { key: FAKE_KEY, baseUrl: studio.baseUrl }, logDestination: { write: () => undefined } });
    const edit = pack.descriptors.find((d) => d.id === 'wildweave_film_edit')!.payload;
    const result = await edit.execute(SAMPLE_ARGS.wildweave_film_edit);
    expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'edit_refused', status: 422, findings: [{ code: 'layer_overflow', sceneId: 's02' }] } } });
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    // The rest of the deep value comes back as it was: only the key is masked.
    let node = (result.output as unknown as { error: { details: { context: unknown } } }).error.details.context;
    for (let i = 0; i < 12; i++) node = (node as { level: unknown }).level;
    expect(node).toBe('quoted wld_live_[redacted]');
  });
});
