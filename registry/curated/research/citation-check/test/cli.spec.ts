import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCitationCli, type CitationCliIO } from '../src/index';
import { FAKE_EMBEDDING, guardNetwork, outsideAttempts, startFixtureServer, type FixtureServer } from './support';

// The `agentos-citations` command, run in this process with its output captured, and once as the built bin.

let server: FixtureServer;
let restore: () => void;
let folder: string;

beforeAll(async () => {
  restore = guardNetwork();
  server = await startFixtureServer();
  folder = await mkdtemp(path.join(tmpdir(), 'citation-cli-'));
});

afterAll(async () => {
  await server.close();
  restore();
  await rm(folder, { recursive: true, force: true });
});

afterEach(() => {
  expect(outsideAttempts.splice(0)).toEqual([]);
  server.received.length = 0;
});

/** Runs the command with its output captured, no browser fallback and a short deadline. */
async function run(argv: string[], env: Record<string, string | undefined> = {}) {
  let stdout = '';
  let stderr = '';
  const io: CitationCliIO = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env,
    options: { fallback: false, timeoutMs: 1_000 },
  };
  const code = await runCitationCli(argv, io);
  return { code, stdout, stderr };
}

async function documentFile(name: string, text: string): Promise<string> {
  const file = path.join(folder, name);
  await writeFile(file, text, 'utf8');
  return file;
}

describe('agentos-citations verify', () => {
  it('prints the markdown log and exits 0 when every claim stands on its page', async () => {
    const file = await documentFile('passing.md', `The report says "The harbour opened in 1887" (${server.origin}/verbatim, read 1 Mar 2026).\n`);
    const { code, stdout, stderr } = await run(['verify', file]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout).toContain('| Line | Verdict | Claim | Source | What the page says |');
    expect(stdout).toContain(`| 1 | exact | The harbour opened in 1887 | <${server.origin}/verbatim> | The harbour opened in 1887 and handled 4,200 ships in its first year. |`);
    expect(stdout).toMatch(/Result: passes\./u);
  });

  it('exits 1 for a claim not found or a page unreachable, and with --allow-unreachable only for the claim not found', async () => {
    const unreachable = await documentFile('unreachable.md', `It says "a sentence on a page that is gone" (${server.origin}/missing).\n`);
    expect((await run(['verify', unreachable])).code).toBe(1);
    const allowed = await run(['verify', unreachable, '--allow-unreachable']);
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toContain('HTTP 404');

    const notFound = await documentFile('not-found.md', `It says "The harbour handled 4,200 ships in its first year" (${server.origin}/paraphrase).\n`);
    const result = await run(['verify', notFound, '--allow-unreachable']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('| 1 | not found |');
    expect(result.stdout).toContain('Nearest passages for the claims not found:');
    expect(result.stdout).toContain('(0.38) The harbour handled many ships.');
  });

  it('prints the report as JSON with --json, and reads a JSON document of claims', async () => {
    const file = await documentFile('claims.json', JSON.stringify([{ claim: 'Twelve berths serve cargo ships', url: `${server.origin}/verbatim` }, { claim: 'A claim with no source at all', url: '' }], null, 2));
    const { code, stdout } = await run(['verify', file, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { checks: Array<{ verdict: string; line: number; page: { outcome: string } | null }>; summary: { counts: Record<string, number> } };
    // JSON.stringify with an indent of 2 puts the two objects' opening braces on lines 2 and 6.
    expect(report.checks.map((check) => [check.line, check.verdict])).toEqual([
      [2, 'exact'],
      [6, 'uncited'],
    ]);
    expect(report.summary.counts).toMatchObject({ exact: 1, uncited: 1 });
    expect(report.checks.map((check) => check.page?.outcome ?? null)).toEqual(['read', null]);
  });

  it('exits 2 for no command, an unknown option, a file it cannot read, an unknown embedding provider and a JSON entry with no claim', async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(['check', 'x.md'])).code).toBe(2);
    expect((await run(['verify', 'x.md', '--colour'])).code).toBe(2);
    const missing = await run(['verify', path.join(folder, 'no-such-file.md')]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/cannot read/u);
    const file = await documentFile('bad.json', '[{ "url": "https://example.org/a" }]');
    expect((await run(['verify', file, '--embeddings', 'cohere'])).code).toBe(2);
    const bad = await run(['verify', file]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/has no claim/u);
    expect(server.received).toHaveLength(0);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: agentos-citations verify <file>/u);
  });

  it('grades with OpenAI embeddings through AgentOS when asked, the key and the base address taken from the environment', async () => {
    const file = await documentFile('embeddings.md', `It says "The harbour handled 4,200 ships in its first year" (${server.origin}/paraphrase).\n`);
    const refused = await run(['verify', file, '--embeddings', 'openai']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toMatch(/OPENAI_API_KEY/u);

    const { code, stdout } = await run(['verify', file, '--embeddings', 'openai', '--json'], { OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: `${server.origin}/v1` });
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { grading: string; checks: Array<{ verdict: string; grader: string; score: number }> };
    expect(report.grading).toBe('embedding');
    expect(report.checks[0]).toMatchObject({ verdict: 'supported', grader: 'embedding' });
    expect(report.checks[0]?.score).toBeCloseTo(1, 6);
    const calls = server.received.filter((request) => request.path === '/v1/embeddings');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.authorization).toBe('Bearer fixture-key');
    const body = JSON.parse(calls[0]?.body ?? '{}') as { model?: string; input?: string[] };
    expect(typeof body.model).toBe('string');
    expect(body.input?.[0]).toBe('The harbour handled 4,200 ships in its first year');
    expect(FAKE_EMBEDDING).toHaveLength(3);
  });

  it('runs as the agentos-citations bin, its exit status the check result', async () => {
    const file = await documentFile('bin.md', `It says "Twelve berths serve cargo ships" (${server.origin}/verbatim) and "Nothing like this sentence is there" (${server.origin}/paraphrase).\n`);
    const bin = path.join(__dirname, '..', 'dist', 'bin.js');
    const { code, stdout } = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [bin, 'verify', file, '--json', '--no-fallback', '--timeout', '2000'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (status) => resolve({ code: status, stdout: out }));
    });
    expect(code).toBe(1);
    const report = JSON.parse(stdout) as { checks: Array<{ verdict: string }> };
    expect(report.checks.map((check) => check.verdict)).toEqual(['exact', 'not_found']);
  });
});
