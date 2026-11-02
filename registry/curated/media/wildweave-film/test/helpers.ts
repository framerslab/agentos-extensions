/**
 * What the tests share: a fake studio (an in-process `node:http` server answering the studio's
 * routes from the synthetic fixtures under `fixtures/studio/`), a synthetic key, a valid argument
 * set for every tool, a stand-in for the engine's process, and a logger whose lines a test reads.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger, type Logger } from '../src/log.js';
import type { ExecFileLike } from '../src/local.js';
import type { ToolName } from '../src/schemas.js';

/** A key of the studio key's shape; synthetic, never a real one. */
export const FAKE_KEY = `wld_live_${'f'.repeat(40)}`;

/** The fake studio's one film. */
export const FILM_ID = 'film-demo-0001';

/** A fixture of the fake studio, parsed. */
export function fixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/studio/${name}.json`, import.meta.url), 'utf8')) as T;
}

export const sha256Hex = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** One request the fake studio took. */
export interface TakenRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

/** The fake studio. */
export interface FakeStudio {
  baseUrl: string;
  requests: TakenRequest[];
  /** The export's base per source: what the repository held at the last crossing (null: none). */
  base: Partial<Record<string, string | null>>;
  /** The proposals the fake studio stored, by id: each one's body without its id, as JSON. */
  proposals: Map<string, string>;
  /** How many of the next submits are stored and then answered with a gateway's 502, as when an answer is lost past the commit. */
  loseSubmitAnswers: number;
  close(): Promise<void>;
}

const PREFIX = '/api/v1/wildweave/studio';

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req-${status}`, ...headers });
  res.end(JSON.stringify(body));
}

/** The export's answer: each fixture text with its hash and the base the test set. */
function exportAnswer(base: FakeStudio['base']): unknown {
  const { recordFormat, texts } = fixture<{ recordFormat: number; texts: Record<string, string> }>('export-sources');
  const sources: Record<string, unknown> = {};
  for (const [name, text] of Object.entries(texts)) {
    const sha256 = sha256Hex(text);
    const baseSha256 = Object.hasOwn(base, name) ? (base[name] ?? null) : sha256;
    sources[name] = { text, sha256, baseSha256, changed: sha256 !== baseSha256, notes: [] };
  }
  return { recordFormat, sources };
}

/** Starts the fake studio on the loopback address; it answers the key it is given and refuses any other. */
export async function startFakeStudio(key = FAKE_KEY): Promise<FakeStudio> {
  const requests: TakenRequest[] = [];
  const base: FakeStudio['base'] = {};
  const proposals = new Map<string, string>();
  const control = { loseSubmitAnswers: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text === '' ? undefined : JSON.parse(text);
      const url = new URL(req.url ?? '/', 'http://fake.invalid');
      const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname;
      requests.push({ method: req.method ?? 'GET', path: `${path}${url.search}`, headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: 'key_rejected' });
      const film = `/films/${FILM_ID}`;
      const route = `${req.method} ${path}`;
      switch (route) {
        case 'GET /films':
          return send(res, 200, fixture('films'));
        case `GET ${film}/timeline`:
          return send(res, 200, fixture('timeline'));
        case `POST ${film}/edits`: {
          const ops = (body as { ops?: Array<{ op: string; durMs?: number }> }).ops ?? [];
          if (ops.some((op) => op.op === 'trim' && (op.durMs ?? 0) < 5000)) return send(res, 422, fixture('edit-refused'));
          return send(res, 200, fixture('edit-applied'));
        }
        case `POST ${film}/export`: {
          const ack = (body as { ack?: Record<string, string> } | undefined)?.ack;
          if (!ack) return send(res, 200, exportAnswer(base));
          for (const [name, sha] of Object.entries(ack)) base[name] = sha;
          return send(res, 200, { seq: 5, sources: Object.fromEntries(Object.entries(ack).map(([name, sha]) => [name, { path: name, sha256: sha }])), rebound: true });
        }
        case `GET ${film}/proposals`:
          return send(res, 200, fixture('proposals'));
        case `POST ${film}/proposals`: {
          // The route as built: a client-named id with the same body answers the proposal that stands (200, replayed);
          // the id under another body answers 409 proposal_id_reused; without an id, each POST is a new proposal.
          const { proposalId, ...fields } = (body ?? {}) as Record<string, unknown>;
          const id = typeof proposalId === 'string' ? proposalId : `server-named-${proposals.size + 1}`;
          const stood = proposals.get(id);
          if (stood !== undefined && stood !== JSON.stringify(fields)) return send(res, 409, { error: 'proposal_id_reused' });
          proposals.set(id, JSON.stringify(fields));
          if (control.loseSubmitAnswers > 0) {
            control.loseSubmitAnswers -= 1;
            res.writeHead(502, { 'content-type': 'text/html' });
            return void res.end('<html><body>502 Bad Gateway</body></html>');
          }
          const proposal = { proposalId: id, filmId: FILM_ID, ...fields, submittedAtMs: 1761955500000, status: 'proposed' };
          return stood === undefined ? send(res, 201, { proposal }) : send(res, 200, { proposal, replayed: true });
        }
        case `GET ${film}/preview`:
          return send(res, 200, fixture('preview'));
        case `POST ${film}/jobs`:
          return send(res, 503, { error: 'not_open' });
        default:
          return send(res, 404, { error: 'not_found' });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    base,
    proposals,
    get loseSubmitAnswers() {
      return control.loseSubmitAnswers;
    },
    set loseSubmitAnswers(count: number) {
      control.loseSubmitAnswers = count;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A logger whose JSON lines the test reads. */
export function capturedLogger(secrets: string[] = []): { log: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const log = createLogger({
    level: 'debug',
    secrets,
    destination: { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  });
  return { log, lines };
}

/** A logger that writes nothing. */
export const silentLog: Logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

/** One call the engine stand-in took. */
export interface EngineCall {
  file: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** A stand-in for the engine's process: records each call and prints what the test gives. */
export function engineStub(answer: (call: EngineCall) => { stdout?: string; stderr?: string; exitCode?: number } = () => ({ stdout: '{"ok":true,"result":{},"records":[]}\n' })): {
  execFile: ExecFileLike;
  calls: EngineCall[];
} {
  const calls: EngineCall[] = [];
  const execFile: ExecFileLike = (file, args, options, callback) => {
    const call = { file, argv: [...args], cwd: options.cwd, env: options.env };
    calls.push(call);
    const out = answer(call);
    const error = out.exitCode && out.exitCode !== 0 ? Object.assign(new Error(`exit ${out.exitCode}`), { code: out.exitCode }) : null;
    queueMicrotask(() => callback(error, out.stdout ?? '', out.stderr ?? ''));
    return undefined;
  };
  return { execFile, calls };
}

/** A valid argument set for every tool: each passes its schema, so a call reaches its mode's first need. */
export const SAMPLE_ARGS: Record<ToolName, Record<string, unknown>> = {
  wildweave_film_list: {},
  wildweave_film_documents: { filmId: FILM_ID },
  wildweave_film_document_read: { documentId: 'doc-demo-0001' },
  wildweave_film_timeline: { filmId: FILM_ID },
  wildweave_film_scene: { filmId: FILM_ID, sceneId: 's01' },
  wildweave_film_validate: { filmId: FILM_ID },
  wildweave_film_edit: { filmId: FILM_ID, editId: 'edit-1', ifUpdatedAtMs: { 'demo:timeline:film': 1 }, ops: [{ op: 'trim', sceneId: 's02', durMs: 8000 }] },
  wildweave_film_edits: { filmId: FILM_ID },
  wildweave_film_revert: { filmId: FILM_ID, toSeq: 1, ifUpdatedAtMs: { 'demo:timeline:film': 1 } },
  wildweave_film_import: { film: '/tmp/film-demo', out: '/tmp/film-demo/out', target: 'dry-run' },
  wildweave_film_export: { filmId: FILM_ID },
  wildweave_film_inspect: { filmId: FILM_ID },
  wildweave_film_cut: { timeline: '/tmp/film-demo/production/timeline.json', assets: '/tmp/film-demo', out: '/tmp/film-demo/production/cut.json' },
  wildweave_film_strip: { cut: '/tmp/film-demo/production/cut.json', assets: '/tmp/film-demo', out: '/tmp/film-demo/render', all: true },
  wildweave_film_coverage: { cut: '/tmp/film-demo/production/cut.json', assets: '/tmp/film-demo', out: '/tmp/film-demo/render' },
  wildweave_film_render: { cut: '/tmp/film-demo/production/cut.json', assets: '/tmp/film-demo', out: '/tmp/film-demo/render', kind: 'draft' },
  wildweave_film_records: { filmId: FILM_ID, jobId: 'job-1' },
  wildweave_film_preview: { filmId: FILM_ID },
  wildweave_film_preview_push: { film: '/tmp/film-demo', out: '/tmp/film-demo/render' },
  wildweave_film_proposals: { filmId: FILM_ID },
  wildweave_film_proposal_submit: { filmId: FILM_ID, sceneId: 's02', kind: 'mark', title: 'A gull', body: '', rights: { basis: 'licensed' }, by: 'film-sound' },
  wildweave_film_proposal_decide: { filmId: FILM_ID, proposalId: '7d0f3c2a-5b1e-4c8d-9a6f-2e4b8c0d1a3f', verdict: 'yes', words: 'yes, keep the gull', source: 'relayed' },
};

/** The tools a key is the first need of (remote, or both called remotely by the sample). */
export const REMOTE_SAMPLES: ToolName[] = [
  'wildweave_film_list',
  'wildweave_film_documents',
  'wildweave_film_document_read',
  'wildweave_film_timeline',
  'wildweave_film_scene',
  'wildweave_film_validate',
  'wildweave_film_edit',
  'wildweave_film_edits',
  'wildweave_film_revert',
  'wildweave_film_export',
  'wildweave_film_inspect',
  'wildweave_film_records',
  'wildweave_film_preview',
  'wildweave_film_proposals',
  'wildweave_film_proposal_submit',
  'wildweave_film_proposal_decide',
];

/** The tools the engine is the first need of. */
export const LOCAL_SAMPLES: ToolName[] = [
  'wildweave_film_import',
  'wildweave_film_cut',
  'wildweave_film_strip',
  'wildweave_film_coverage',
  'wildweave_film_render',
  'wildweave_film_preview_push',
];

/**
 * The sha256 of each word the package never holds: the import keys of a private film and its name.
 * They are kept as hashes so this public source names neither; a file holds one when the hash of any
 * of its words, lowercased, is in the set.
 */
export const BANNED_WORD_HASHES = new Set([
  '8534af4f09de0030e7d3c4a14cbd285d41cc8033f0276d927cdd826285fd7736',
  'f8bec3a777a4d5663ce80a68ca11958d0f141135af225c20bf7bb533ed94170f',
]);

/** The words of a text whose hash is banned. */
export function bannedWords(text: string): string[] {
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return [...words].filter((word) => BANNED_WORD_HASHES.has(createHash('sha256').update(word).digest('hex')));
}
