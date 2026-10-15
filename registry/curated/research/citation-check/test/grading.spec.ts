import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkCitations, managerEmbeddings, type CitationCheckOptions } from '../src/index';
import { guardNetwork, outsideAttempts, startFixtureServer, type FixtureServer } from './support';

// The embedding path: a claim that is not on its page word for word is graded by AgentOS's CitationVerifier against the
// page's sentences, through an embedding function the caller passes in. The stub below gives each sentence of the
// paraphrase page an axis of its own and each claim the vector its verdict needs, so the verdicts are exact.

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
});

const QUIET: CitationCheckOptions = { fallback: false, timeoutMs: 1_000 };

/** Unit vector `index` of seven. */
function axis(index: number): number[] {
  return Array.from({ length: 7 }, (_, at) => (at === index ? 1 : 0));
}

const SUPPORTED = 'The port took in a great many vessels.';
const WEAK = 'Some vessels docked there over the decades.';
const UNVERIFIABLE = 'The castle has a moat around it.';
const CONTRADICTED = 'No ships came during the first year.';
const EXACT = 'The harbour handled many ships';

const VECTORS = new Map<string, number[]>([
  ['The harbour handled many ships.', axis(0)],
  ['Ships arrived in the first year.', axis(1)],
  ['The harbour is old.', axis(2)],
  ['Fishing boats leave before dawn.', axis(3)],
  ['Its first year was busy.', axis(4)],
  [SUPPORTED, axis(0)],
  // Cosine 0.5 with the first sentence: between the unverifiable (0.3) and the supported (0.6) thresholds.
  [WEAK, [0.5, 0, 0, 0, 0, Math.sqrt(0.75), 0]],
  [UNVERIFIABLE, axis(5)],
  [CONTRADICTED, axis(1)],
]);

function claims() {
  return [EXACT, SUPPORTED, WEAK, UNVERIFIABLE, CONTRADICTED].map((text, index) => ({
    line: index + 1,
    claim: text,
    url: `${server.origin}/paraphrase`,
    exact: false,
  }));
}

describe('checkCitations with an embedding function', () => {
  it("grades the claims not found word for word through AgentOS's CitationVerifier, an NLI function turning a supported claim into a contradicted one", async () => {
    const embedded: string[][] = [];
    const embedFn = async (texts: string[]) => {
      embedded.push([...texts]);
      return texts.map((text) => VECTORS.get(text) ?? axis(6));
    };
    const nliFn = async (premise: string, hypothesis: string) =>
      hypothesis === CONTRADICTED && premise === 'Ships arrived in the first year.'
        ? { label: 'contradiction' as const, score: 0.95 }
        : { label: 'entailment' as const, score: 0.9 };

    const report = await checkCitations(claims(), { ...QUIET, embedFn, nliFn });

    expect(report.grading).toBe('embedding');
    expect(report.checks.map((check) => [check.verdict, check.grader])).toEqual([
      ['exact', 'exact'],
      ['supported', 'embedding'],
      ['weak', 'embedding'],
      ['unverifiable', 'embedding'],
      ['contradicted', 'embedding'],
    ]);
    expect(report.checks[1]).toMatchObject({ score: 1, passage: 'The harbour handled many ships.' });
    expect(report.checks[2]?.score).toBeCloseTo(0.5, 6);
    expect(report.checks[3]).toMatchObject({ score: 0, passage: null });
    expect(report.checks[4]).toMatchObject({ passage: 'Ships arrived in the first year.' });
    // Classical first: the claim that stands word for word never reaches the embedding function, and the page's
    // sentences are embedded with the four others in one call.
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).not.toContain(EXACT);
    expect(embedded[0]?.slice(0, 4)).toEqual([SUPPORTED, WEAK, UNVERIFIABLE, CONTRADICTED]);
    expect(report.summary.counts).toMatchObject({ exact: 1, supported: 1, weak: 1, unverifiable: 1, contradicted: 1 });
    expect(report.checks.map((check) => check.page?.outcome)).toEqual(['read', 'read', 'read', 'read', 'read']);
  });

  it('leaves the claims to the lexical grader with a note when the embedding function fails', async () => {
    const embedFn = async () => {
      throw new Error('embedding service unavailable');
    };
    const report = await checkCitations(claims().slice(1, 2), { ...QUIET, embedFn });
    expect(report.checks[0]).toMatchObject({ verdict: 'not_found', grader: 'lexical' });
    expect(report.checks[0]?.note).toMatch(/embedding service unavailable/u);
    expect(report.checks[0]?.page).toMatchObject({ outcome: 'read', status: 200 });
  });

  it('takes an embedding function from an AgentOS embedding manager and refuses an answer with a failed text', async () => {
    const requests: unknown[] = [];
    const manager = {
      generateEmbeddings: async (request: { texts: string | string[]; modelId?: string }) => {
        requests.push(request);
        const texts = Array.isArray(request.texts) ? request.texts : [request.texts];
        return { embeddings: texts.map((text) => VECTORS.get(text) ?? axis(6)), modelId: 'fixture-model', providerId: 'fixture', usage: { totalTokens: 0 } };
      },
    };
    const embedFn = managerEmbeddings(manager, { modelId: 'fixture-model' });
    expect(await embedFn([SUPPORTED])).toEqual([axis(0)]);
    expect(requests).toEqual([{ texts: [SUPPORTED], modelId: 'fixture-model' }]);

    const failing = managerEmbeddings({
      generateEmbeddings: async () => ({ embeddings: [], modelId: 'm', providerId: 'p', usage: { totalTokens: 0 }, errors: [{ textIndex: 0, message: 'refused' }] }),
    });
    await expect(failing(['one text'])).rejects.toThrow(/refused/u);
  });
});
