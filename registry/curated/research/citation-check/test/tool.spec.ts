import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CitationVerifyTool, createExtensionPack } from '../src/index';
import { guardNetwork, outsideAttempts, startFixtureServer, type FixtureServer } from './support';

// The `citation_verify` tool as an agent calls it: through the pack factory, reading pages through AgentOS's checked
// egress, the hosted policy by default.

let server: FixtureServer;
let restore: () => void;

beforeAll(async () => {
  restore = guardNetwork();
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
  restore();
});

afterEach(() => {
  expect(outsideAttempts.splice(0)).toEqual([]);
  server.received.length = 0;
});

const CONTEXT = { gmiId: 'fixture-gmi', personaId: 'fixture-persona', userContext: { userId: 'fixture-user' } } as never;

describe('the citation_verify tool', () => {
  it('comes from the pack factory with inert inputs, as one tool descriptor with an optional OpenAI key', () => {
    const pack = createExtensionPack({ options: {} });
    expect(pack.name).toBe('@framers/agentos-ext-citation-check');
    expect(pack.descriptors).toHaveLength(1);
    const [descriptor] = pack.descriptors;
    expect(descriptor).toMatchObject({ id: 'citation_verify', kind: 'tool', requiredSecrets: [{ id: 'openai.apiKey', optional: true }] });
    const tool = descriptor?.payload as CitationVerifyTool;
    expect(tool.name).toBe('citation_verify');
    expect(tool.hasSideEffects).toBe(false);
    expect(tool.inputSchema).toMatchObject({ type: 'object', required: ['document'] });
    expect(() => createExtensionPack({ options: { embeddings: 'cohere' } })).toThrow(/embeddings/u);
  });

  it('checks a document through the local egress policy, following a redirect, and returns the report, the log and whether it fails', async () => {
    const tool = createExtensionPack({ options: { egress: 'local', timeoutMs: 2_000 } }).descriptors[0]?.payload as CitationVerifyTool;
    const document = [
      `The report says "The harbour opened in 1887" (${server.origin}/moved).`,
      `The page says "a sentence the page does not hold" (${server.origin}/paraphrase).`,
    ].join('\n');
    const result = await tool.execute({ document }, CONTEXT);
    expect(result.success).toBe(true);
    expect(result.output?.report.checks.map((check) => check.verdict)).toEqual(['exact', 'not_found']);
    expect(result.output?.fails).toBe(true);
    expect(result.output?.log).toContain('| 1 | exact |');
    expect(result.output?.report.pages.find((page) => page.url.endsWith('/moved'))).toMatchObject({ outcome: 'read', finalUrl: `${server.origin}/verbatim` });
    expect(server.received.map((request) => request.path).sort()).toEqual(['/moved', '/paraphrase', '/verbatim']);
  });

  it('by default refuses a loopback address through the hosted egress policy and sends nothing to it', async () => {
    const tool = new CitationVerifyTool();
    const result = await tool.execute({ document: `It says "The harbour opened in 1887" (${server.origin}/verbatim).` }, CONTEXT);
    expect(result.success).toBe(true);
    expect(result.output?.report.checks[0]).toMatchObject({ verdict: 'unreachable' });
    expect(result.output?.report.pages[0]).toMatchObject({ outcome: 'unreachable', failure: 'refused' });
    expect(result.output?.report.checks[0]?.page).toEqual(result.output?.report.pages[0]);
    expect(result.output?.fails).toBe(true);
    expect((await tool.execute({ document: `It says "The harbour opened in 1887" (${server.origin}/verbatim).`, allowUnreachable: true }, CONTEXT)).output?.fails).toBe(false);
    expect(server.received).toHaveLength(0);
  });

  it('answers a document it cannot read, or arguments of the wrong type, with an error instead of throwing', async () => {
    const tool = new CitationVerifyTool({ fetch: globalThis.fetch });
    const bad = await tool.execute({ document: '[{ "url": "https://example.org/a" }]' }, CONTEXT);
    expect(bad).toMatchObject({ success: false });
    expect(bad.error).toMatch(/has no claim/u);
    expect(await tool.execute({ document: 42 } as never, CONTEXT)).toMatchObject({ success: false });
    expect(await tool.execute({ document: 'x', format: 'yaml' } as never, CONTEXT)).toMatchObject({ success: false });
    expect(server.received).toHaveLength(0);
  });
});
