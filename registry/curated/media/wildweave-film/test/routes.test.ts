/**
 * End to end over the real path: each tool of the studio's tool surface, called through the SDK's MCP
 * client and the pack's MCP server, reaches the studio route or the engine command its row names, with
 * the body or the argument array it should carry, and answers what the route or the command answered.
 * The studio is a scripted `node:http` server that records each request and answers as the routes do,
 * from synthetic fixtures; the engine is a stand-in for its process. Then the refusals, through the
 * AgentOS pack over the same HTTP: each code the routes answer reaches the caller as itself, a 4xx is
 * sent once, and a 503 is sent twice more, after 1 s and 4 s, for a call the route answers idempotently.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExtensionPack, createToolContext, resolveConfig, type WildweaveFilmPack, type WildweaveFilmTool } from '../src/index.js';
import { createWildweaveMcpServer } from '../src/mcp/index.js';
import type { ToolName } from '../src/schemas.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';
import {
  FAKE_KEY,
  FILM_ID,
  REMOTE_SAMPLES,
  SAMPLE_ARGS,
  engineStub,
  fixture,
  silentLog,
  startScriptedStudio,
  type ScriptedAnswer,
  type ScriptedRequest,
  type ScriptedStudio,
} from './helpers.js';

const PREFIX = '/api/v1/wildweave/studio';
const F = `/films/${FILM_ID}`;
const DOCUMENT_ID = 'doc-demo-0001';
const PROPOSAL_ID = '5c2e8a41-9b7d-4f3e-8a6c-1d0b9e7f3a25';
const TIMES = { 'demo:timeline:storyboard': 1761955301000, 'demo:timeline:film': 1761955302000, 'demo:timeline:record': 1761955303000 };

/** What each route answers, by method and path without the query: synthetic, in the shapes the routes answer. */
const ROUTES: Record<string, ScriptedAnswer> = {
  'GET /films': { status: 200, body: fixture('films') },
  [`GET ${F}/documents`]: {
    status: 200,
    body: { documents: [{ importKey: 'demo:timeline:film', documentId: DOCUMENT_ID, kind: 'film', title: 'The Lantern Keeper', updatedAtMs: 1761955302000, sourceSha256: 'a'.repeat(64), edited: false }] },
  },
  [`GET /documents/${DOCUMENT_ID}`]: {
    status: 200,
    body: { document: { documentId: DOCUMENT_ID, kind: 'film', title: 'The Lantern Keeper', contentText: 'Every night the keeper climbed the stairs.', contentJson: null, updatedAtMs: 1761955302000 } },
  },
  [`GET ${F}/timeline`]: { status: 200, body: fixture('timeline') },
  [`GET ${F}/scenes/s01`]: {
    status: 200,
    body: { scene: { id: 's01', order: 1, startMs: 0, durMs: 8000 }, sidecar: {}, readiness: { picture: 'ready', voice: { '0': 'stand-in' }, bed: 'ready', sound: 'local-only' }, findings: [] },
  },
  [`POST ${F}/validate`]: { status: 200, body: { ok: true, findings: [], byScene: {}, counts: { errors: 0, warnings: 0, notes: 0 }, cutSha256: 'b'.repeat(64) } },
  [`POST ${F}/edits`]: { status: 200, body: fixture('edit-applied') },
  [`GET ${F}/edits`]: {
    status: 200,
    body: { edits: [{ seq: 4, kind: 'edit', editId: 'edit-1', atMs: 1761955302000, by: { accountId: 'account-demo' }, ops: [], sha256: { timeline: 'c'.repeat(64) } }] },
  },
  [`POST ${F}/revert`]: { status: 200, body: { seq: 6, restored: ['demo:timeline:film'] } },
  [`POST ${F}/export`]: { status: 200, body: { recordFormat: 2, sources: {} } },
  [`GET ${F}/inspect`]: { status: 200, body: { report: { scenes: 3, chapters: [] } } },
  [`POST ${F}/jobs`]: { status: 503, body: { error: 'not_open' } },
  [`GET ${F}/jobs/job-1`]: { status: 503, body: { error: 'not_open' } },
  [`GET ${F}/preview`]: { status: 200, body: fixture('preview') },
  [`GET ${F}/proposals`]: { status: 200, body: fixture('proposals') },
  [`POST ${F}/proposals`]: { status: 201, body: { proposal: { proposalId: PROPOSAL_ID, filmId: FILM_ID, status: 'proposed' } } },
};

/** The route's answer to a request, as the table holds it; a decision answers the proposal it names. */
function routeAnswer(request: ScriptedRequest): ScriptedAnswer {
  const path = request.path.split('?')[0]!;
  const decision = /^\/films\/[^/]+\/proposals\/([^/]+)\/decision$/.exec(path);
  if (request.method === 'POST' && decision) return { status: 200, body: { proposal: { proposalId: decision[1], status: 'noted' } } };
  return ROUTES[`${request.method} ${path}`] ?? { status: 404, body: { error: 'not_found' } };
}

/** The one text block a tool answers, parsed; a block that is not the tool's JSON is the SDK refusing the arguments. */
function answerOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text?: string }>;
  expect(content).toHaveLength(1);
  const text = content[0]!.text ?? '';
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`the tool never ran: the server answered ${text}`);
  }
}

/** Every edit op the module admits, each kind once, so the SDK's validator reads every branch of the op union. */
const EDIT_OPS = [
  { op: 'reorder', sceneIds: ['s02', 's01', 's03'] },
  { op: 'move', sceneId: 's03', before: null },
  { op: 'trim', sceneId: 's02', durMs: 8000 },
  { op: 'clip_window', sceneId: 's01', inMs: 500, outMs: 6500, speed: 1.5 },
  { op: 'clip_sound', sceneId: 's01', audio: 'mute', duck: true, gain: -6 },
  { op: 'transition', sceneId: 's01', out: { kind: 'wipe', durMs: 400, direction: 'from-left' }, bedFade: { durMs: 800 } },
  { op: 'transition', sceneId: 's02', out: null, bedFade: null },
  { op: 'bed', sceneId: 's03', bed: null },
  { op: 'beds', beds: { harbour: 'assets/audio/harbour-loop.wav' } },
  { op: 'marks', sceneId: 's02', sfx: [{ asset: 'gull', atMs: 1200 }] },
  { op: 'marks_table', marks: { gull: 'assets/audio/gull.wav' } },
  {
    op: 'layers',
    sceneId: 's03',
    layers: [
      { kind: 'strip', text: 'Morning', atMs: 0, durMs: 2000, reveal: 'words', words: [{ word: 'Morning', startMs: 0, endMs: 600, source: 'tiled' }] },
      { kind: 'intertitle', text: 'Later', atMs: 2000, durMs: 1000 },
      { kind: 'text-frame', title: 'The keeper', body: 'He kept the lamp.', atMs: 3000, durMs: 1500 },
    ],
  },
];

const SUBMIT = {
  proposalId: PROPOSAL_ID,
  sceneId: 's02',
  kind: 'clip',
  title: 'A gull over the harbour',
  body: 'Two seconds of the gull, under the line.',
  rights: { basis: 'licensed', holder: 'A sound library', licence: 'CC0', url: 'https://library.example.invalid/gull', attribution: 'A sound library' },
  assetRef: 'assets/clips/gull.mp4',
  by: 'film-editor',
};

/** A remote tool's call and the request the studio should take for it. */
interface RemoteRow {
  label: string;
  tool: ToolName;
  args: Record<string, unknown>;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

const REMOTE_ROWS: RemoteRow[] = [
  { label: 'wildweave_film_list', tool: 'wildweave_film_list', args: {}, method: 'GET', path: '/films' },
  { label: 'wildweave_film_documents', tool: 'wildweave_film_documents', args: { filmId: FILM_ID }, method: 'GET', path: `${F}/documents` },
  { label: 'wildweave_film_document_read', tool: 'wildweave_film_document_read', args: { documentId: DOCUMENT_ID }, method: 'GET', path: `/documents/${DOCUMENT_ID}` },
  { label: 'wildweave_film_timeline', tool: 'wildweave_film_timeline', args: { filmId: FILM_ID }, method: 'GET', path: `${F}/timeline` },
  { label: 'wildweave_film_scene', tool: 'wildweave_film_scene', args: { filmId: FILM_ID, sceneId: 's01' }, method: 'GET', path: `${F}/scenes/s01` },
  { label: 'wildweave_film_validate (in the app)', tool: 'wildweave_film_validate', args: { filmId: FILM_ID }, method: 'POST', path: `${F}/validate`, body: {} },
  {
    label: 'wildweave_film_edit (every op kind, a dry run)',
    tool: 'wildweave_film_edit',
    args: { filmId: FILM_ID, editId: 'edit-7', ifUpdatedAtMs: TIMES, ops: EDIT_OPS, dryRun: true },
    method: 'POST',
    path: `${F}/edits`,
    body: { editId: 'edit-7', ifUpdatedAtMs: TIMES, ops: EDIT_OPS, dryRun: true },
  },
  { label: 'wildweave_film_edits (after a seq)', tool: 'wildweave_film_edits', args: { filmId: FILM_ID, since: 3 }, method: 'GET', path: `${F}/edits?since=3` },
  {
    label: 'wildweave_film_revert (forced)',
    tool: 'wildweave_film_revert',
    args: { filmId: FILM_ID, toSeq: 2, ifUpdatedAtMs: TIMES, force: true },
    method: 'POST',
    path: `${F}/revert`,
    body: { toSeq: 2, ifUpdatedAtMs: TIMES, force: true },
  },
  { label: 'wildweave_film_export (the texts alone)', tool: 'wildweave_film_export', args: { filmId: FILM_ID }, method: 'POST', path: `${F}/export`, body: {} },
  { label: 'wildweave_film_inspect (in the app)', tool: 'wildweave_film_inspect', args: { filmId: FILM_ID }, method: 'GET', path: `${F}/inspect` },
  {
    label: 'wildweave_film_render (a job on the box: not_open)',
    tool: 'wildweave_film_render',
    args: { filmId: FILM_ID, kind: 'draft', jobs: 2 },
    method: 'POST',
    path: `${F}/jobs`,
    body: { kind: 'draft', jobs: 2 },
  },
  { label: 'wildweave_film_records (a job on the box: not_open)', tool: 'wildweave_film_records', args: { filmId: FILM_ID, jobId: 'job-1' }, method: 'GET', path: `${F}/jobs/job-1` },
  { label: 'wildweave_film_preview', tool: 'wildweave_film_preview', args: { filmId: FILM_ID }, method: 'GET', path: `${F}/preview` },
  { label: 'wildweave_film_proposals (by status)', tool: 'wildweave_film_proposals', args: { filmId: FILM_ID, status: 'noted' }, method: 'GET', path: `${F}/proposals?status=noted` },
  {
    label: 'wildweave_film_proposal_submit (every field)',
    tool: 'wildweave_film_proposal_submit',
    args: { filmId: FILM_ID, ...SUBMIT },
    method: 'POST',
    path: `${F}/proposals`,
    body: SUBMIT,
  },
  {
    label: 'wildweave_film_proposal_decide (a note)',
    tool: 'wildweave_film_proposal_decide',
    args: { filmId: FILM_ID, proposalId: PROPOSAL_ID, verdict: 'note', words: 'shorter, and later in the scene', source: 'relayed' },
    method: 'POST',
    path: `${F}/proposals/${PROPOSAL_ID}/decision`,
    body: { verdict: 'note', words: 'shorter, and later in the scene', source: 'relayed' },
  },
  {
    label: 'a filmId is one path segment, encoded',
    tool: 'wildweave_film_timeline',
    args: { filmId: 'film/../documents?x=1' },
    method: 'GET',
    path: '/films/film%2F..%2Fdocuments%3Fx%3D1/timeline',
  },
];

/** A local tool's call and the argument array the engine should run with; `repo` is the configured film repository. */
interface LocalRow {
  label: string;
  tool: ToolName;
  args: Record<string, unknown>;
  argv: (repo: string, baseUrl: string) => string[];
  /** Whether the child gets the studio key, as WILDS_IMPORT_TOKEN. */
  token: boolean;
}

const LOCAL_ROWS: LocalRow[] = [
  {
    label: 'wildweave_film_import (production, the configured film repository)',
    tool: 'wildweave_film_import',
    args: { out: '/r/out', target: 'production', force: true, exportCheck: true },
    token: true,
    argv: (repo, base) => ['wildweave-film', 'import', `--film=${repo}`, '--out=/r/out', '--target=production', '--force', '--export-check', `--base-url=${base}`, '--json'],
  },
  {
    label: "wildweave_film_cut (the repository's timeline and sidecar)",
    tool: 'wildweave_film_cut',
    args: { assets: '/r', out: '/r/production/cut.json', normDir: '/r/norm', takes: '/r/docs/takes.md', draft: true },
    token: false,
    argv: (repo) => [
      'wildweave-film',
      'cut',
      `--timeline=${join(repo, 'production', 'timeline.json')}`,
      `--sidecar=${join(repo, 'production', 'render.json')}`,
      '--assets=/r',
      '--out=/r/production/cut.json',
      '--norm-dir=/r/norm',
      '--takes=/r/docs/takes.md',
      '--draft',
      '--json',
    ],
  },
  {
    label: 'wildweave_film_strip (one scene)',
    tool: 'wildweave_film_strip',
    args: { cut: '/r/cut.json', assets: '/r', out: '/r/render', scene: 's02', frames: 6 },
    token: false,
    argv: () => ['wildweave-film', 'strip', '--cut=/r/cut.json', '--assets=/r', '--out=/r/render', '--scene=s02', '--frames=6', '--json'],
  },
  {
    label: 'wildweave_film_strip (every scene)',
    tool: 'wildweave_film_strip',
    args: { cut: '/r/cut.json', assets: '/r', out: '/r/render', all: true },
    token: false,
    argv: () => ['wildweave-film', 'strip', '--cut=/r/cut.json', '--assets=/r', '--out=/r/render', '--all', '--json'],
  },
  {
    label: 'wildweave_film_coverage',
    tool: 'wildweave_film_coverage',
    args: { cut: '/r/cut.json', assets: '/r', out: '/r/render' },
    token: false,
    argv: () => ['wildweave-film', 'coverage', '--cut=/r/cut.json', '--assets=/r', '--out=/r/render', '--json'],
  },
  {
    label: 'wildweave_film_validate (local, the repository as the assets)',
    tool: 'wildweave_film_validate',
    args: { cut: '/r/cut.json', draft: true, strict: true },
    token: false,
    argv: (repo) => ['wildweave-film', 'validate', '--cut=/r/cut.json', `--assets=${repo}`, '--draft', '--strict', '--json'],
  },
  {
    label: 'wildweave_film_inspect (local)',
    tool: 'wildweave_film_inspect',
    args: { cut: '/r/cut.json', assets: '/r' },
    token: false,
    argv: () => ['wildweave-film', 'inspect', '--cut=/r/cut.json', '--assets=/r', '--json'],
  },
  {
    label: 'wildweave_film_render (local, the master)',
    tool: 'wildweave_film_render',
    args: { cut: '/r/cut.json', assets: '/r', out: '/r/render', kind: 'master', strict: true, jobs: 3, by: 'chapter', part: 'part-02', resume: true, requireStrips: true },
    token: false,
    argv: () => ['wildweave-film', 'render', '--cut=/r/cut.json', '--assets=/r', '--out=/r/render', '--strict', '--jobs=3', '--by=chapter', '--part=part-02', '--resume', '--require-strips', '--json'],
  },
  {
    label: 'wildweave_film_preview_push (the configured film repository)',
    tool: 'wildweave_film_preview_push',
    args: { out: '/r/render', scenes: ['s01', 's03'], render: true },
    token: true,
    argv: (repo, base) => ['wildweave-film', 'preview', `--film=${repo}`, '--out=/r/render', '--target=production', '--scenes=s01,s03', '--render', `--base-url=${base}`, '--json'],
  },
];

let studio: ScriptedStudio;
let scratch: string;
let engineDir: string;
let repo: string;
let engine: ReturnType<typeof engineStub>;
let client: Client;
let closeMcp: () => Promise<void>;

beforeAll(async () => {
  studio = await startScriptedStudio();
  scratch = mkdtempSync(join(tmpdir(), 'wildweave-film-routes-'));
  engineDir = join(scratch, 'engine');
  mkdirSync(engineDir);
  repo = join(scratch, 'film');
  engine = engineStub((call) => ({ stdout: `${JSON.stringify({ ok: true, result: { ran: call.argv[1] }, records: [] })}\n` }));
  // The server as the bin and the HTTP entry build it, over a tool context whose engine is the stand-in.
  const config = await resolveConfig({ key: FAKE_KEY, baseUrl: studio.baseUrl, engineDir, filmRepo: repo }, undefined, {});
  const ctx = createToolContext(config, silentLog, { execFile: engine.execFile });
  const handler = createMcpHandler(() => createWildweaveMcpServer(config, silentLog, ctx));
  client = new Client({ name: 'wildweave-film-routes', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL('http://mcp.test.invalid/mcp'), { fetch: (url, init) => handler.fetch(new Request(url, init)) }));
  closeMcp = async () => {
    await client.close();
    await handler.close();
  };
});

afterAll(async () => {
  await closeMcp?.();
  await studio?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  studio.requests.length = 0;
  studio.answer = routeAnswer;
  engine.calls.length = 0;
});

describe('each tool, called by an MCP client, reaches the call its row names', () => {
  it.each(REMOTE_ROWS)('$label', async (row) => {
    const result = await client.callTool({ name: row.tool, arguments: row.args });
    const answer = answerOf(result);
    expect(studio.requests).toHaveLength(1);
    const taken = studio.requests[0]!;
    expect(taken.fullPath.startsWith(`${PREFIX}/`)).toBe(true);
    expect({ method: taken.method, path: taken.path, body: taken.body }).toEqual({ method: row.method, path: row.path, body: row.body });
    expect(taken.authorization).toBe(`Bearer ${FAKE_KEY}`);
    const routed = routeAnswer(taken);
    if (routed.status < 300) expect(answer).toMatchObject({ ok: true, result: routed.body as Record<string, unknown> });
    else expect(answer).toMatchObject({ ok: false, error: { code: (routed.body as { error: string }).error, status: routed.status } });
    expect(result.isError ?? false).toBe(routed.status >= 300);
    expect(engine.calls).toHaveLength(0);
  });

  it.each(LOCAL_ROWS)('$label', async (row) => {
    const result = await client.callTool({ name: row.tool, arguments: row.args });
    const answer = answerOf(result);
    expect(engine.calls).toHaveLength(1);
    const call = engine.calls[0]!;
    expect(call.file).toBe('pnpm');
    expect(call.cwd).toBe(engineDir);
    expect(call.argv).toEqual(row.argv(repo, studio.baseUrl));
    expect(call.argv.join(' ')).not.toContain(FAKE_KEY);
    expect(call.env.WILDS_IMPORT_TOKEN).toBe(row.token ? FAKE_KEY : undefined);
    expect(answer).toEqual({ ok: true, result: { ran: call.argv[1] }, records: [] });
    expect(result.isError ?? false).toBe(false);
    expect(studio.requests).toHaveLength(0);
  });

  it("wildweave_film_records (local) reads a render folder's records, and answers not_found for a folder that is not there", async () => {
    const out = join(scratch, 'render');
    mkdirSync(join(out, 'reports'), { recursive: true });
    mkdirSync(join(out, 'strips'));
    writeFileSync(join(out, 'film.record.json'), JSON.stringify({ cutSha256: 'd'.repeat(64) }));
    writeFileSync(join(out, 'reports', 'validate.json'), JSON.stringify({ ok: true, counts: { errors: 0 } }));
    writeFileSync(join(out, 'reports', 'plan.json'), '{ not json');
    writeFileSync(join(out, 'strips', 'index.json'), JSON.stringify({ cutSha256: 'd'.repeat(64), scenes: ['s01'] }));
    writeFileSync(join(out, 'run.json'), JSON.stringify({ wallMs: 1200 }));
    writeFileSync(join(out, 'film.mp4'), '');
    const answer = answerOf(await client.callTool({ name: 'wildweave_film_records', arguments: { out } }));
    expect(answer).toEqual({
      ok: true,
      result: {
        record: { cutSha256: 'd'.repeat(64) },
        plan: { unreadable: true },
        validate: { ok: true, counts: { errors: 0 } },
        strips: { cutSha256: 'd'.repeat(64), scenes: ['s01'] },
        run: { wallMs: 1200 },
        artifacts: ['film.mp4', 'film.record.json', 'run.json'],
      },
    });
    expect(answerOf(await client.callTool({ name: 'wildweave_film_records', arguments: { out: join(scratch, 'nowhere') } }))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(engine.calls).toHaveLength(0);
    expect(studio.requests).toHaveLength(0);
  });

  // A tool that serves both modes runs neither when its arguments name both, or neither: no route, no engine.
  it.each([
    { label: 'validate with filmId and cut', tool: 'wildweave_film_validate' as ToolName, args: { filmId: FILM_ID, cut: '/r/cut.json' } },
    { label: 'inspect with neither', tool: 'wildweave_film_inspect' as ToolName, args: {} },
    { label: 'render with neither filmId nor cut', tool: 'wildweave_film_render' as ToolName, args: { kind: 'draft' } },
    { label: 'render with a cut but no assets or out', tool: 'wildweave_film_render' as ToolName, args: { cut: '/r/cut.json', kind: 'draft' } },
    { label: 'records with neither out nor a job', tool: 'wildweave_film_records' as ToolName, args: { filmId: FILM_ID } },
    { label: 'strip with neither scene nor all', tool: 'wildweave_film_strip' as ToolName, args: { cut: '/r/cut.json', assets: '/r', out: '/r/render' } },
    { label: 'strip with both scene and all', tool: 'wildweave_film_strip' as ToolName, args: { cut: '/r/cut.json', assets: '/r', out: '/r/render', scene: 's01', all: true } },
  ])('refuses $label as arg_invalid, calling nothing', async ({ tool, args }) => {
    const result = await client.callTool({ name: tool, arguments: args });
    expect(answerOf(result)).toMatchObject({ ok: false, error: { code: 'arg_invalid' } });
    expect(result.isError).toBe(true);
    expect(studio.requests).toHaveLength(0);
    expect(engine.calls).toHaveLength(0);
  });
});

/**
 * The spec's tool table (section 2.2): each tool's mode and the key scopes it needs. A tool has side effects when it
 * writes, renders or imports, and so do the two read tools that write files: the export (with writeTo) and the cut
 * (its cut.json). A preview push posts to the preview at the write scope and stages its parts at the import scope.
 */
type Scope = 'read' | 'write' | 'render' | 'import';
const TABLE: Record<ToolName, { mode: 'remote' | 'local' | 'both'; scopes: Scope[]; sideEffects: boolean }> = {
  wildweave_film_list: { mode: 'remote', scopes: ['read'], sideEffects: false },
  wildweave_film_documents: { mode: 'remote', scopes: ['read'], sideEffects: false },
  wildweave_film_document_read: { mode: 'remote', scopes: ['read'], sideEffects: false },
  wildweave_film_timeline: { mode: 'remote', scopes: ['read'], sideEffects: false },
  wildweave_film_scene: { mode: 'remote', scopes: ['read'], sideEffects: false },
  wildweave_film_validate: { mode: 'both', scopes: ['read'], sideEffects: false },
  wildweave_film_edit: { mode: 'remote', scopes: ['write'], sideEffects: true },
  wildweave_film_edits: { mode: 'remote', scopes: ['read'], sideEffects: false },
  wildweave_film_revert: { mode: 'remote', scopes: ['write'], sideEffects: true },
  wildweave_film_import: { mode: 'local', scopes: ['import'], sideEffects: true },
  wildweave_film_export: { mode: 'remote', scopes: ['read'], sideEffects: true },
  wildweave_film_inspect: { mode: 'both', scopes: ['read'], sideEffects: false },
  wildweave_film_cut: { mode: 'local', scopes: ['read'], sideEffects: true },
  wildweave_film_strip: { mode: 'local', scopes: ['render'], sideEffects: true },
  wildweave_film_coverage: { mode: 'local', scopes: ['render'], sideEffects: true },
  wildweave_film_render: { mode: 'both', scopes: ['render'], sideEffects: true },
  wildweave_film_records: { mode: 'both', scopes: ['read'], sideEffects: false },
  wildweave_film_preview: { mode: 'remote', scopes: ['read'], sideEffects: false },
  wildweave_film_preview_push: { mode: 'local', scopes: ['write', 'import'], sideEffects: true },
  wildweave_film_proposals: { mode: 'remote', scopes: ['read'], sideEffects: false },
  wildweave_film_proposal_submit: { mode: 'remote', scopes: ['write'], sideEffects: true },
  wildweave_film_proposal_decide: { mode: 'remote', scopes: ['write'], sideEffects: true },
};

describe("each tool's mode, scope and side effects, as the spec's table sets them", () => {
  // A client that reads readOnlyHint may run a read-only tool without asking; an AgentOS host reads hasSideEffects.
  it('lists every tool that writes, renders or imports as not read-only to an MCP client, and with side effects to an AgentOS host', async () => {
    const listed: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      listed.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const pack = await createExtensionPack({ options: {}, logDestination: { write: () => undefined } });
    expect(TOOL_DEFINITIONS.map((def) => def.name).sort()).toEqual(Object.keys(TABLE).sort());
    expect(listed.map((tool) => tool.name).sort()).toEqual(Object.keys(TABLE).sort());
    for (const def of TOOL_DEFINITIONS) {
      const row = TABLE[def.name];
      expect(def.mode, def.name).toBe(row.mode);
      expect(row.scopes, def.name).toContain(def.scope);
      expect(listed.find((tool) => tool.name === def.name)?.annotations?.readOnlyHint, def.name).toBe(!row.sideEffects);
      expect(pack.descriptors.find((d) => d.id === def.name)?.payload.hasSideEffects, def.name).toBe(row.sideEffects);
    }
  });
});

/** Each code a studio route answers, with the status it answers it with (the gate's, the shared answers' and each route's own). */
const ROUTE_CODES: Array<[string, number]> = [
  ['key_rejected', 401],
  ['sign_in_required', 401],
  ['forge_required', 403],
  ['scope_required', 403],
  ['source_app_needs_session', 403],
  ['not_found', 404],
  ['seq_unknown', 404],
  ['scene_unknown', 404],
  ['invalid_body', 400],
  ['invalid_since', 400],
  ['invalid_status', 400],
  ['bundle_refused', 400],
  ['stale_write', 409],
  ['edit_id_reused', 409],
  ['film_unreadable', 409],
  ['record_reimport_required', 409],
  ['import_between', 409],
  ['import_in_progress', 409],
  ['files_not_staged', 409],
  ['export_refused', 409],
  ['already_decided', 409],
  ['proposal_id_reused', 409],
  ['body_too_large', 413],
  ['edit_refused', 422],
  ['cut_refused', 422],
  ['preview_refused', 422],
  ['file_key_invalid', 422],
  ['bed_unknown', 422],
];

describe('the refusals, through the AgentOS pack over HTTP', () => {
  const waits: number[] = [];
  let pack: WildweaveFilmPack;
  const toolOf = (p: WildweaveFilmPack, name: ToolName): WildweaveFilmTool => {
    const descriptor = p.descriptors.find((d) => d.id === name);
    if (!descriptor) throw new Error(`the pack lists no ${name}`);
    return descriptor.payload;
  };

  beforeAll(async () => {
    pack = await createExtensionPack({
      options: { key: FAKE_KEY, baseUrl: studio.baseUrl },
      logDestination: { write: () => undefined },
      deps: { sleep: async (ms) => void waits.push(ms) },
    });
  });
  beforeEach(() => {
    waits.length = 0;
  });

  it.each(ROUTE_CODES)('%s (HTTP %i) reaches the caller as itself, sent once, on a read and on a write its id makes idempotent', async (code, status) => {
    studio.answer = () => ({ status, body: { error: code } });
    for (const name of ['wildweave_film_timeline', 'wildweave_film_edit'] as const) {
      studio.requests.length = 0;
      const result = await toolOf(pack, name).execute(SAMPLE_ARGS[name]);
      expect(result, name).toMatchObject({ success: false, output: { ok: false, error: { code, status } } });
      expect(studio.requests, name).toHaveLength(1);
    }
    expect(waits).toEqual([]);
  });

  // wilds.ai's proxy answers a bearer that does not begin with the studio key's prefix, on the studio's paths, before
  // the gate runs: 401 with the words below as its error. The tools name a refused key key_rejected (spec 3.5).
  it("reads the proxy's 401 for a bearer that is not a studio key as key_rejected, sent once", async () => {
    studio.answer = () => ({ status: 401, body: { error: 'Invalid or expired token' } });
    const result = await toolOf(pack, 'wildweave_film_list').execute({});
    expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'key_rejected', status: 401 } } });
    expect(studio.requests).toHaveLength(1);
  });

  const NEVER_RETRIED = new Set<ToolName>(['wildweave_film_revert']);

  it.each(REMOTE_SAMPLES)('%s: a 503 is sent twice more, after 1 s and 4 s, when the route answers the call idempotently; else once', async (name) => {
    // Two gateway answers with no body, then the route's own.
    studio.answer = (request) => (studio.requests.length <= 2 ? { status: 503 } : routeAnswer(request));
    const result = await toolOf(pack, name).execute(SAMPLE_ARGS[name]);
    if (NEVER_RETRIED.has(name)) {
      expect(studio.requests).toHaveLength(1);
      expect(waits).toEqual([]);
      expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'http_503', status: 503 } } });
      return;
    }
    expect(studio.requests).toHaveLength(3);
    expect(waits).toEqual([1000, 4000]);
    // The same request each time: a submit keeps the one proposalId the tool named.
    expect(new Set(studio.requests.map((r) => `${r.method} ${r.path} ${JSON.stringify(r.body)}`)).size).toBe(1);
    expect(result.success).toBe(routeAnswer(studio.requests[2]!).status < 300);
  });

  it('sends a render job once on a 503, since the job carries no id the route could answer again', async () => {
    studio.answer = () => ({ status: 503 });
    const result = await toolOf(pack, 'wildweave_film_render').execute({ filmId: FILM_ID, kind: 'draft' });
    expect(result).toMatchObject({ success: false, output: { ok: false, error: { code: 'http_503', status: 503 } } });
    expect(studio.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('answers key_missing for a production import and a preview push with an engine but no key, and runs nothing', async () => {
    const stub = engineStub();
    const keyless = await createExtensionPack({
      options: { baseUrl: studio.baseUrl, engineDir, filmRepo: repo },
      logDestination: { write: () => undefined },
      deps: { execFile: stub.execFile },
    });
    expect(await toolOf(keyless, 'wildweave_film_import').execute({ out: '/r/out', target: 'production' })).toMatchObject({ success: false, output: { ok: false, error: { code: 'key_missing' } } });
    expect(await toolOf(keyless, 'wildweave_film_preview_push').execute({ out: '/r/render' })).toMatchObject({ success: false, output: { ok: false, error: { code: 'key_missing' } } });
    expect(stub.calls).toHaveLength(0);
    expect(studio.requests).toHaveLength(0);
  });
});
