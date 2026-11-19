import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ValueAgreementChecker } from '@framers/agentos-ext-grounding-guard';
import {
  ClaimChecker,
  type ClaimCheckOutcome,
  type ClaimGrader,
  type ClaimJudge,
  type ClaimJudgement,
  type ClaimPassage,
  type ClaimPublicVectors,
  type SpokenClaim,
} from '../src/index';

// The claim checker with the vectors a host already holds: a passage's own vector, a store of public sentences'
// vectors by the hash of their exact input, a verdict key a host keeps and hands back, and the host's say before
// anything is sent. Every embeddings call is counted, text by text.

const CLAIM: SpokenClaim = {
  heard: 'The Treaty of Versailles was signed in 1918',
  heardSentence: 'The Treaty of Versailles was signed in 1918.',
  statement: 'The Treaty of Versailles was signed in 1918.',
};
const LEAD = 'The Treaty of Versailles was a peace treaty signed on 28 June 1919.';
const QUOTE = 'signed on 28 June 1919';
const GRADER: ClaimGrader = { judgeModel: 'openai:gpt-6-luna', embedding: { model: 'text-embedding-3-small', dimensions: 2 } };
const SECRET = 'a host secret of enough length to key the verdicts';

const checker = new ValueAgreementChecker({ names: true });

function passage(content: string, group: string, kind = 'encyclopedia', title = 'Treaty of Versailles'): ClaimPassage {
  return { content, title, group, kind, url: `https://reference.example.org/${encodeURIComponent(group)}` };
}

/** The hash a public sentence's vector is stored under: the model, NUL, the size, NUL and the text. */
function hashOf(text: string): string {
  return createHash('sha256').update(`${GRADER.embedding.model}\u0000${GRADER.embedding.dimensions}\u0000${text}`).digest('hex');
}

/** Embeddings that answer a table's vector for a text, else one axis for a text naming Versailles; ten tokens a text. */
function countingEmbed(table: ReadonlyMap<string, number[]> = new Map()) {
  const batches: string[][] = [];
  const embed = async (texts: string[], _signal: AbortSignal) => {
    batches.push([...texts]);
    return {
      vectors: texts.map((text) => table.get(text) ?? (text.includes('Versailles') ? [1, 0] : [0, 1])),
      usage: { in: texts.length * 10 },
    };
  };
  return { embed, batches };
}

function fakeJudge(answer: ClaimJudgement) {
  const asked: Array<{ system: string; prompt: string }> = [];
  const judge: ClaimJudge = async ({ system, prompt }) => {
    asked.push({ system, prompt });
    return { value: answer, usage: { in: 120, out: 12 } };
  };
  return { judge, asked };
}

/** A store of public vectors in memory, recording each read's and each write's hashes. */
function memoryPublic(clean: (text: string) => boolean | Promise<boolean> = () => true) {
  const rows = new Map<string, number[]>();
  const reads: string[][] = [];
  const writes: string[][] = [];
  const store: ClaimPublicVectors = {
    get: async (hashes) => {
      reads.push([...hashes]);
      return new Map(hashes.filter((hash) => rows.has(hash)).map((hash) => [hash, rows.get(hash) as number[]] as const));
    },
    put: async (put) => {
      writes.push(put.map((row) => row.hash));
      for (const row of put) rows.set(row.hash, [...row.vector]);
    },
    clean,
  };
  return { store, rows, reads, writes };
}

const signal = (): AbortSignal => new AbortController().signal;

const keyOf = (outcome: ClaimCheckOutcome): string | undefined => (outcome as { key?: string }).key;

/** Eight public sentences about the claim, each its own page. */
function publicSentences(): ClaimPassage[] {
  return Array.from({ length: 8 }, (_, index) => ({
    ...passage(`The Treaty of Versailles was signed in ${1911 + index}.`, `page:${index}`, 'page', `Page ${index}`),
    publicKey: true,
  }));
}

describe('ClaimChecker with stored public vectors', () => {
  it('embeds 9 texts on a first check over 8 public sentences, and the statement alone on the same check again', async () => {
    const sentences = publicSentences();
    expect(checker.passages(CLAIM.heard, sentences.map((one) => ({ text: one.content, group: one.group }))).found).toHaveLength(8);
    const { embed, batches } = countingEmbed();
    const { judge } = fakeJudge({ relation: 'none', quote: '' });
    const stored = memoryPublic();
    const claims = new ClaimChecker({ embed, judge, checker, grader: GRADER, publicVectors: stored.store });

    const first = await claims.check(CLAIM, sentences, { signal: signal() });
    const second = await claims.check(CLAIM, sentences, { signal: signal() });

    expect(batches.map((batch) => batch.length)).toEqual([9, 1]);
    expect(batches[1]).toEqual([CLAIM.statement]);
    expect(first.usage.vectorHits).toBe(0);
    expect(second.usage.vectorHits).toBe(8);
    expect(stored.writes).toHaveLength(1);
    expect([...(stored.writes[0] ?? [])].sort()).toEqual(sentences.map((one) => hashOf(one.content)).sort());
    expect([...stored.rows.keys()].sort()).toEqual(sentences.map((one) => hashOf(one.content)).sort());
  });

  it('embeds a note beside public sentences on every check, and never stores it', async () => {
    const [one, two] = publicSentences();
    const note = passage('My notes say the Treaty of Versailles was signed in 1918 in Paris.', 'note:history', 'note', 'History notes');
    const { embed, batches } = countingEmbed();
    const { judge } = fakeJudge({ relation: 'none', quote: '' });
    const stored = memoryPublic();
    const claims = new ClaimChecker({ embed, judge, checker, grader: GRADER, publicVectors: stored.store });

    await claims.check(CLAIM, [one, two, note], { signal: signal() });
    await claims.check(CLAIM, [one, two, note], { signal: signal() });

    expect(batches[0]).toContain(note.content);
    expect(batches[1]).toEqual([CLAIM.statement, note.content]);
    expect(stored.rows.has(hashOf(note.content))).toBe(false);
    expect(stored.reads.flat()).not.toContain(hashOf(note.content));
  });

  it('embeds a public sentence the clean test refuses on every check, and never reads or writes its vector', async () => {
    const [one, two] = publicSentences();
    const named = { ...passage('The Treaty of Versailles was signed in 1918 by Jane Roe.', 'page:named', 'page', 'A page'), publicKey: true };
    const { embed, batches } = countingEmbed();
    const { judge } = fakeJudge({ relation: 'none', quote: '' });
    const stored = memoryPublic((text) => !text.includes('Jane Roe'));
    const claims = new ClaimChecker({ embed, judge, checker, grader: GRADER, publicVectors: stored.store });

    await claims.check(CLAIM, [one, two, named], { signal: signal() });
    await claims.check(CLAIM, [one, two, named], { signal: signal() });

    expect(batches[0]).toContain(named.content);
    expect(batches[1]).toEqual([CLAIM.statement, named.content]);
    expect(stored.reads.flat()).not.toContain(hashOf(named.content));
    expect(stored.writes.flat()).not.toContain(hashOf(named.content));
  });

  it('costs only its hits when the store rejects, answers after vectorReadMs, or fails to write', async () => {
    const sentences = publicSentences();
    const { judge } = fakeJudge({ relation: 'none', quote: '' });
    const failing: ClaimPublicVectors = {
      get: async () => {
        throw new Error('the store is down');
      },
      put: async () => {
        throw new Error('the store is down');
      },
      clean: () => true,
    };
    const down = countingEmbed();
    const outcome = await new ClaimChecker({ embed: down.embed, judge, checker, grader: GRADER, publicVectors: failing }).check(CLAIM, sentences, { signal: signal() });
    expect(outcome).toMatchObject({ kind: 'ended', reason: 'judge_none' });
    expect(down.batches.map((batch) => batch.length)).toEqual([9]);

    // A store that holds every vector but answers after the bound counts as empty.
    const full = new Map(sentences.map((one) => [hashOf(one.content), [1, 0]] as const));
    const slow: ClaimPublicVectors = {
      get: (hashes) => new Promise((resolve) => setTimeout(() => resolve(new Map(hashes.map((hash) => [hash, full.get(hash) as number[]] as const))), 300)),
      put: async () => {},
      clean: () => true,
    };
    const late = countingEmbed();
    const slowOutcome = await new ClaimChecker({ embed: late.embed, judge, checker, grader: GRADER, publicVectors: slow, vectorReadMs: 20 }).check(CLAIM, sentences, {
      signal: signal(),
    });
    expect(late.batches.map((batch) => batch.length)).toEqual([9]);
    expect(slowOutcome.usage.vectorHits).toBe(0);
  });
});

describe('ClaimChecker with passage vectors', () => {
  it('sends the embedder the statement alone when every sentence carries its passage vector', async () => {
    const vector = { embedding: [1, 0], level: 'passage' as const, passageId: 'document:d1#p1', inputHash: 'input-1' };
    const sentences = [1915, 1916, 1917].map((year) => ({ ...passage(`The Treaty of Versailles was signed in ${year}.`, 'document:d1', 'document', 'Plan'), vector }));
    const { embed, batches } = countingEmbed();
    const { judge, asked } = fakeJudge({ relation: 'none', quote: '' });
    await new ClaimChecker({ embed, judge, checker }).check(CLAIM, sentences, { signal: signal() });
    expect(batches).toEqual([[CLAIM.statement]]);
    expect(asked).toHaveLength(1);
  });

  it('ranks sentence vectors and passage vectors each in their own class, and names the earlier in the checker\'s order', async () => {
    const texts = [
      'The Treaty of Versailles was signed in 1919 in the Hall of Mirrors.',
      'The Treaty of Versailles was signed in 1919 after six months of talks.',
      'The Treaty of Versailles was signed in 1919 by the Allied powers.',
      'The Treaty of Versailles was signed in 1919 and took effect in 1920.',
    ];
    const sentences = texts.map((text, index) => passage(text, `source:${index}`, 'page', `Page ${index}`));
    const order = checker.passages(CLAIM.heard, sentences.map((one) => ({ text: one.content, group: one.group }))).found.map((found) => found.text);
    expect(order).toHaveLength(4);
    const at = (place: number): ClaimPassage => sentences.find((one) => one.content === order[place]) as ClaimPassage;
    // Sentence vectors at places 0 and 2, the second the nearest of all; passage vectors at places 1 and 3.
    const table = new Map<string, number[]>([
      [CLAIM.statement, [1, 0]],
      [order[0] as string, [0.2, 1]],
      [order[2] as string, [1, 0]],
    ]);
    at(1).vector = { embedding: [0.6, 0.8], level: 'passage', passageId: 'p1', inputHash: 'i1' };
    at(3).vector = { embedding: [0.5, 0.866], level: 'passage', passageId: 'p3', inputHash: 'i3' };
    const { embed, batches } = countingEmbed(table);
    const { judge, asked } = fakeJudge({ relation: 'none', quote: '' });

    await new ClaimChecker({ embed, judge, checker }).check(CLAIM, sentences, { signal: signal() });

    expect(batches).toEqual([[CLAIM.statement, order[0], order[2]]]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.prompt.endsWith(`\n${order[1]}`)).toBe(true);
  });

  it('names nothing when each class holds one candidate and neither is above a cosine of 0', async () => {
    const sentence = passage('The Treaty of Versailles was signed in 1919 in the Hall of Mirrors.', 'page:one', 'page', 'Page');
    const inDoc = {
      ...passage('The Treaty of Versailles was signed in 1919 by the Allied powers.', 'document:d1', 'document', 'Plan'),
      vector: { embedding: [0, 1], level: 'passage' as const, passageId: 'p', inputHash: 'i' },
    };
    const { embed, batches } = countingEmbed(new Map([[CLAIM.statement, [1, 0]], [sentence.content, [0, 1]]]));
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [sentence, inDoc], { signal: signal() });
    expect(outcome).toMatchObject({ kind: 'ended', reason: 'no_best', judged: 0 });
    expect(batches).toEqual([[CLAIM.statement, sentence.content]]);
    expect(asked).toEqual([]);
  });
});

describe('ClaimChecker with one sentence compared', () => {
  it('makes no embeddings call, and the judge decides', async () => {
    const { embed, batches } = countingEmbed();
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')], { signal: signal() });
    expect(batches).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') return;
    expect(outcome.decision.relation).toBe('differs');
    expect(outcome.verdict).toMatchObject({ verdict: 'contradicted', confidence: 0, scored: false, sourceIndex: 0 });
    expect(outcome.usage).toEqual({ judgeIn: 120, judgeOut: 12, embedIn: 0, vectorHits: 0 });
  });
});

describe("ClaimChecker's verdict key", () => {
  /** A check that asks the host before sending and is refused, so it answers its key and sends nothing. */
  async function keyFor(given: ClaimPassage[], found: ClaimPassage[], context = 'account:a1/run:r1', secret = SECRET): Promise<string> {
    const { embed, batches } = countingEmbed();
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const outcome = await new ClaimChecker({ embed, judge, checker, grader: GRADER, verdictSecret: secret }).check(CLAIM, given, {
      signal: signal(),
      found,
      verdictContext: context,
      beforeSend: () => false,
    });
    expect(outcome).toMatchObject({ kind: 'ended', reason: 'limited' });
    expect(batches).toEqual([]);
    expect(asked).toEqual([]);
    const key = keyOf(outcome);
    expect(typeof key).toBe('string');
    return key as string;
  }

  const lead = (over: Partial<ClaimPassage> = {}): ClaimPassage => ({
    ...passage(LEAD, 'encyclopedia:Treaty_of_Versailles'),
    ref: 'wikipedia:Treaty_of_Versailles@1201',
    vector: { embedding: [1, 0], level: 'passage', passageId: 'document:d1#p1', inputHash: 'input-1' },
    ...over,
  });
  const agreeing = (count: number, changed?: number): ClaimPassage[] =>
    Array.from({ length: count }, (_, index) =>
      passage(`My notes say the Treaty of Versailles was signed in 1918 (${index === changed ? 'changed' : index}).`, `note:${index}`, 'note', 'Notes'),
    );

  it('changes with each thing that decides the verdict, and stays the same for the same check', async () => {
    const base = await keyFor([lead()], [lead(), ...agreeing(24)]);
    expect(await keyFor([lead()], [lead(), ...agreeing(24)])).toBe(base);
    const variants = await Promise.all([
      keyFor([lead()], [lead(), ...agreeing(25)]),
      keyFor([lead()], [lead(), ...agreeing(24, 3)]),
      keyFor([lead({ group: 'encyclopedia:Other' })], [lead({ group: 'encyclopedia:Other' }), ...agreeing(24)]),
      keyFor([lead({ vector: { embedding: [0.9, 0.1], level: 'passage', passageId: 'document:d1#p1', inputHash: 'input-1' } })], [lead(), ...agreeing(24)]),
      keyFor([lead({ vector: { embedding: [1, 0], level: 'passage', passageId: 'document:d1#p1', inputHash: 'input-2' } })], [lead(), ...agreeing(24)]),
      keyFor([lead({ ref: 'wikipedia:Treaty_of_Versailles@1202' })], [lead({ ref: 'wikipedia:Treaty_of_Versailles@1202' }), ...agreeing(24)]),
      keyFor([lead()], [lead(), ...agreeing(24)], 'account:a1/run:r2'),
      keyFor([lead()], [lead(), ...agreeing(24)], 'account:a1/run:r1', `${SECRET}, rotated`),
    ]);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('answers a key the host holds with nothing sent and without asking the host', async () => {
    const { embed, batches } = countingEmbed();
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    let askedHost = 0;
    const beforeSend = () => {
      askedHost += 1;
      return true;
    };
    const claims = new ClaimChecker({ embed, judge, checker, grader: GRADER, verdictSecret: SECRET });
    const options = { signal: signal(), verdictContext: 'account:a1/run:r1', beforeSend };
    const first = await claims.check(CLAIM, [lead()], options);
    expect(first.kind).toBe('decided');
    const key = keyOf(first) as string;
    expect(askedHost).toBe(1);
    const sentBefore = { batches: batches.length, asked: asked.length };

    const again = await claims.check(CLAIM, [lead()], { ...options, known: [key] });

    expect(again).toEqual({ kind: 'known', key, judged: 0, usage: { judgeIn: 0, judgeOut: 0, embedIn: 0, vectorHits: 0 } });
    expect({ batches: batches.length, asked: asked.length }).toEqual(sentBefore);
    expect(askedHost).toBe(1);
  });

  it('sends nothing when the host refuses before the first send', async () => {
    const { embed, batches } = countingEmbed();
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, publicSentences(), { signal: signal(), beforeSend: async () => false });
    expect(outcome).toMatchObject({ kind: 'ended', reason: 'limited', judged: 0 });
    expect(batches).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('ClaimChecker after review', () => {
  const two = (): ClaimPassage[] =>
    [1915, 1916].map((year) => passage(`The Treaty of Versailles was signed in ${year}.`, `page:${year}`, 'page', `Page ${year}`));

  it('rejects an embeddings answer whose vector is of another size or holds a value that is not finite, before the judge', async () => {
    for (const bad of [[1, 0, 0], [Number.NaN, 0]]) {
      const embed = async (texts: string[]) => ({ vectors: texts.map((_, index) => (index === 1 ? bad : [1, 0])), usage: { in: texts.length } });
      const { judge, asked } = fakeJudge({ relation: 'none', quote: '' });
      await expect(new ClaimChecker({ embed, judge, checker, grader: GRADER }).check(CLAIM, two(), { signal: signal() })).rejects.toThrow('embeddings');
      expect(asked).toEqual([]);
    }
  });

  it('throws a RangeError, with no grader, for a passage vector of another size than the claim', async () => {
    const vector = { embedding: [1, 0, 0], level: 'passage' as const, passageId: 'document:d1#p1', inputHash: 'input-1' };
    const { embed } = countingEmbed();
    const { judge, asked } = fakeJudge({ relation: 'none', quote: '' });
    await expect(
      new ClaimChecker({ embed, judge, checker }).check(CLAIM, two().map((one) => ({ ...one, vector })), { signal: signal() }),
    ).rejects.toThrow(RangeError);
    expect(asked).toEqual([]);
  });

  it('rejects at once when the signal aborts while the public vectors are written', async () => {
    const controller = new AbortController();
    const reason = new Error('stopped while writing');
    const store: ClaimPublicVectors = {
      get: async () => new Map(),
      // The write never settles; the check is aborted as it starts.
      put: () => {
        controller.abort(reason);
        return new Promise(() => {});
      },
      clean: () => true,
    };
    const { embed } = countingEmbed();
    const { judge } = fakeJudge({ relation: 'none', quote: '' });
    const started = Date.now();
    await expect(
      new ClaimChecker({ embed, judge, checker, grader: GRADER, publicVectors: store, vectorReadMs: 60_000 }).check(CLAIM, publicSentences().slice(0, 2), {
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("changes the verdict key with the checker's rules the grader names", async () => {
    const keyUnder = async (rules: string): Promise<string | undefined> => {
      const { embed } = countingEmbed();
      const { judge } = fakeJudge({ relation: 'differs', quote: QUOTE });
      const outcome = await new ClaimChecker({ embed, judge, checker, grader: { ...GRADER, rules }, verdictSecret: SECRET }).check(
        CLAIM,
        [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')],
        { signal: signal(), verdictContext: 'account:a1/run:r1', beforeSend: () => false },
      );
      return keyOf(outcome);
    };
    const named = await keyUnder('names:true');
    expect(typeof named).toBe('string');
    expect(await keyUnder('names:true')).toBe(named);
    expect(await keyUnder('names:false')).not.toBe(named);
  });
});

describe('ClaimChecker reads the claim once', () => {
  it('keys and sends the claim as it was when the call began, whatever the host changes while beforeSend is awaited', async () => {
    const claim: SpokenClaim = { ...CLAIM };
    const { embed, batches } = countingEmbed();
    const { judge, asked } = fakeJudge({ relation: 'none', quote: '' });
    const sentences = [1915, 1916].map((year) => passage(`The Treaty of Versailles was signed in ${year}.`, `page:${year}`, 'page', `Page ${year}`));
    const changed = 'The Treaty of Versailles was signed in 1920.';
    await new ClaimChecker({ embed, judge, checker, grader: GRADER, verdictSecret: SECRET }).check(claim, sentences, {
      signal: signal(),
      beforeSend: () => {
        claim.statement = changed;
        return true;
      },
    });
    expect(batches[0]?.[0]).toBe(CLAIM.statement);
    expect(asked.map((one) => one.prompt).join('\n')).not.toContain(changed);
  });
});
