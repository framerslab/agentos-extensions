import { describe, expect, it } from 'vitest';
import { ValueAgreementChecker } from '@framers/agentos-ext-grounding-guard';
import {
  CLAIM_QUOTE_MAX_WORDS,
  ClaimChecker,
  claimJudgePrompt,
  claimJudgeSystem,
  type ClaimJudge,
  type ClaimJudgement,
  type ClaimPassage,
  type SpokenClaim,
} from '../src/index';

// The claim checker over the grounding guard's own checker and AgentOS's CitationVerifier, with a fake judge and fake
// embeddings: the judge's instruction by the passage's kind, a decision on values, the judge's "none", a quote that
// cuts a word, the veto over a later passage, a later passage that agrees by code, no passage about the claim, an abort
// while the judge is pending, a passage held back from the models that still vetoes, and the embeddings failing.

const CLAIM: SpokenClaim = {
  heard: 'The Treaty of Versailles was signed in 1918',
  heardSentence: 'The Treaty of Versailles was signed in 1918.',
  statement: 'The Treaty of Versailles was signed in 1918.',
};
const LEAD = 'The Treaty of Versailles was a peace treaty signed on 28 June 1919.';
const QUOTE = 'signed on 28 June 1919';

const checker = new ValueAgreementChecker({ names: true });

function passage(content: string, group: string, kind = 'encyclopedia', title = 'Treaty of Versailles'): ClaimPassage {
  return { content, title, group, kind, url: `https://reference.example.org/${encodeURIComponent(group)}` };
}

/** Embeddings that put every text naming Versailles on one axis and every other text on another, ten tokens a text. */
function fakeEmbed() {
  const batches: string[][] = [];
  const embed = async (texts: string[], _signal: AbortSignal) => {
    batches.push([...texts]);
    return { vectors: texts.map((text) => (text.includes('Versailles') ? [1, 0] : [0, 1])), usage: { in: texts.length * 10 } };
  };
  return { embed, batches };
}

/** A judge that answers one judgement and records what it was asked. */
function fakeJudge(answer: ClaimJudgement) {
  const asked: Array<{ system: string; prompt: string }> = [];
  const judge: ClaimJudge = async ({ system, prompt }) => {
    asked.push({ system, prompt });
    return { value: answer, usage: { in: 120, out: 12 } };
  };
  return { judge, asked };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("the judge's instruction", () => {
  it('names the source by the passage kind, every instruction opening alike', () => {
    const cases: Array<[string, string]> = [
      ['encyclopedia', 'an encyclopedia article'],
      ['news', 'a web page'],
      ['official', 'a web page'],
      ['page', 'a web page'],
      ['forum', 'a web page'],
      ['paper', "a paper's abstract"],
      ['note', "the person's own notes or documents"],
      ['document', "the person's own notes or documents"],
      ['podcast', 'a source'],
    ];
    for (const [kind, from] of cases) {
      const system = claimJudgeSystem(kind);
      expect(system.startsWith('You compare one sentence heard in a room with one sentence from')).toBe(true);
      expect(system.split('\n')[0]).toBe(`You compare one sentence heard in a room with one sentence from ${from}.`);
      expect(system).toContain(`at most ${CLAIM_QUOTE_MAX_WORDS} words`);
    }
    expect(CLAIM_QUOTE_MAX_WORDS).toBe(20);
  });

  it('puts the heard sentence, the claim and the titled sentence in the prompt', () => {
    expect(claimJudgePrompt('Heard it.', 'It holds.', 'A title', 'A sentence.')).toBe('HEARD: Heard it.\nCHECK: It holds.\nSOURCE: A title\nA sentence.');
  });
});

describe('ClaimChecker.check', () => {
  it('decides "differs" on the values: the year 1918 heard beside 1919 in the named sentence', async () => {
    const { embed, batches } = fakeEmbed();
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const lead = passage(LEAD, 'encyclopedia:Treaty_of_Versailles');
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [lead], { signal: signal() });

    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') return;
    expect(outcome.decision.relation).toBe('differs');
    expect(outcome.decision.basis).toBe('values');
    expect(outcome.named).toBe(lead);
    expect(outcome.decision.sentences).toEqual([lead]);
    expect(outcome.decision.sentences[0]).toBe(lead);
    const pair = outcome.decision.pairs[0];
    expect(pair?.kind).toBe('year');
    expect(CLAIM.heardSentence.slice(pair?.heard.start, pair?.heard.end)).toBe('1918');
    expect(LEAD.slice(pair?.source.start, pair?.source.end)).toBe('1919');
    expect(outcome.quote).toBe(QUOTE);
    expect(outcome.verdict.verdict).toBe('contradicted');
    expect(outcome.judged).toBe(1);
    expect(outcome.usage).toEqual({ judgeIn: 120, judgeOut: 12, embedIn: 20 });
    expect(batches).toEqual([[CLAIM.statement, LEAD]]);
    expect(asked).toEqual([
      { system: claimJudgeSystem('encyclopedia'), prompt: claimJudgePrompt(CLAIM.heardSentence, CLAIM.statement, 'Treaty of Versailles', LEAD) },
    ]);
  });

  it('decides "matches" for the year heard as written in the sentence', async () => {
    const { embed } = fakeEmbed();
    const { judge } = fakeJudge({ relation: 'matches', quote: QUOTE });
    const said: SpokenClaim = {
      heard: 'The Treaty of Versailles was signed in 1919',
      heardSentence: 'The Treaty of Versailles was signed in 1919.',
      statement: 'The Treaty of Versailles was signed in 1919.',
    };
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(said, [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')], { signal: signal() });
    expect(outcome.kind).toBe('decided');
    if (outcome.kind === 'decided') {
      expect(outcome.decision.relation).toBe('matches');
      expect(outcome.verdict.verdict).toBe('supported');
    }
  });

  it('ends judge_none when the judge answers none, after one call', async () => {
    const { embed } = fakeEmbed();
    const { judge } = fakeJudge({ relation: 'none', quote: '' });
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')], { signal: signal() });
    expect(outcome).toMatchObject({ kind: 'ended', reason: 'judge_none', judged: 1 });
  });

  it('ends quote for a quote that cuts a word, one past the word limit, and an empty one', async () => {
    const long = Array.from({ length: CLAIM_QUOTE_MAX_WORDS + 1 }, () => 'treaty').join(' ');
    for (const quote of ['signed on 28 Ju', long, '']) {
      const { embed } = fakeEmbed();
      const { judge } = fakeJudge({ relation: 'differs', quote });
      const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')], { signal: signal() });
      expect(outcome).toMatchObject({ kind: 'ended', reason: 'quote', judged: 1 });
    }
  });

  it('ends no_passage, with nothing embedded or judged, when no passage shares two stems with the claim', async () => {
    const { embed, batches } = fakeEmbed();
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage('The harbour opened in 1887.', 'page:harbour', 'page', 'Harbour')], {
      signal: signal(),
    });
    expect(outcome).toEqual({ kind: 'ended', reason: 'no_passage', judged: 0, usage: { judgeIn: 0, judgeOut: 0, embedIn: 0 } });
    expect(batches).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('ends no_best, with no judge call, when no passage is near the claim by cosine', async () => {
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const embed = async (texts: string[]) => ({ vectors: texts.map((_, index) => (index === 0 ? [1, 0] : [0, 1])), usage: { in: texts.length } });
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')], { signal: signal() });
    expect(outcome).toMatchObject({ kind: 'ended', reason: 'no_best', judged: 0 });
    expect(asked).toEqual([]);
  });

  it("rejects with the signal's reason when it aborts while the judge is pending, the judge asked once", async () => {
    const { embed } = fakeEmbed();
    const controller = new AbortController();
    let calls = 0;
    let started: () => void = () => {};
    const judging = new Promise<void>((resolve) => {
      started = resolve;
    });
    const judge: ClaimJudge = () => {
      calls += 1;
      started();
      return new Promise(() => {});
    };
    const pending = new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')], { signal: controller.signal });
    await judging;
    const reason = new Error('the check ran out of time');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  it('rejects with the embeddings error, with no judge call', async () => {
    const failure = new Error('the embeddings failed');
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const embed = async () => {
      throw failure;
    };
    await expect(new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')], { signal: signal() })).rejects.toBe(failure);
    expect(asked).toEqual([]);
  });

  it('rejects with the judge error, which the verifier alone would keep to itself', async () => {
    const { embed } = fakeEmbed();
    const failure = new Error('the model answered 500');
    const judge: ClaimJudge = async () => {
      throw failure;
    };
    await expect(new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage(LEAD, 'encyclopedia:Treaty_of_Versailles')], { signal: signal() })).rejects.toBe(failure);
  });

  it('a passage held back in found alone stops a "differs", and reaches neither the embeddings nor the judge', async () => {
    const { embed, batches } = fakeEmbed();
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const lead = passage(LEAD, 'encyclopedia:Treaty_of_Versailles');
    const held = passage('The Treaty of Versailles was signed in 1918.', 'note:history', 'note', 'History notes');
    const outcome = await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [lead], { signal: signal(), found: [lead, held] });
    expect(outcome).toMatchObject({ kind: 'ended', reason: 'undecided', judged: 1 });
    expect(batches.flat()).not.toContain(held.content);
    expect(asked.map((one) => one.prompt).join('\n')).not.toContain(held.content);
  });

  it('compares at most maxPassages passages, in the order the checker ranks them', async () => {
    const { embed, batches } = fakeEmbed();
    const { judge } = fakeJudge({ relation: 'none', quote: '' });
    const many = Array.from({ length: 5 }, (_, index) => passage(`The Treaty of Versailles was signed in ${1915 + index}.`, `page:${index}`, 'page', `Page ${index}`));
    await new ClaimChecker({ embed, judge, checker, maxPassages: 3 }).check(CLAIM, many, { signal: signal() });
    expect(batches[0]).toHaveLength(4);
  });

  it('reads a web page with the instruction for a web page, and a note with the instruction for the person\'s own', async () => {
    for (const [kind, title] of [
      ['news', 'Archive story'],
      ['note', 'History notes'],
    ] as const) {
      const { embed } = fakeEmbed();
      const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
      await new ClaimChecker({ embed, judge, checker }).check(CLAIM, [passage(LEAD, `${kind}:one`, kind, title)], { signal: signal() });
      expect(asked[0]?.system).toBe(claimJudgeSystem(kind));
      expect(asked[0]?.prompt).toContain(`SOURCE: ${title}\n`);
    }
  });

  it('refuses a maxPassages that is not a whole number of at least 1', () => {
    const { embed } = fakeEmbed();
    const { judge } = fakeJudge({ relation: 'none', quote: '' });
    expect(() => new ClaimChecker({ embed, judge, checker, maxPassages: 0 })).toThrow(RangeError);
  });
});

describe('ClaimChecker: later passages, by code alone', () => {
  async function firstDiffers(checkerUsed: ClaimChecker, lead: ClaimPassage) {
    const outcome = await checkerUsed.check(CLAIM, [lead], { signal: signal() });
    if (outcome.kind !== 'decided') throw new Error(`expected a decision, got ${outcome.reason}`);
    return outcome;
  }

  it('revisit answers null once a later passage of another source agrees with 1918, so the "differs" is not shown', async () => {
    const { embed } = fakeEmbed();
    const { judge } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const claims = new ClaimChecker({ embed, judge, checker });
    const lead = passage(LEAD, 'encyclopedia:Treaty_of_Versailles');
    const first = await firstDiffers(claims, lead);
    const agreeing = passage('The Treaty of Versailles was signed in 1918.', 'page:almanac', 'page', 'Almanac');
    expect(claims.revisit(first, CLAIM, [lead, agreeing])).toBeNull();
    const again = claims.revisit(first, CLAIM, [lead]);
    expect(again?.relation).toBe('differs');
    expect(again?.sentences).toEqual([lead]);
  });

  it('agree answers a later passage of another source with 1919, and not one with 1920 or one of the first source', async () => {
    const { embed } = fakeEmbed();
    const { judge, asked } = fakeJudge({ relation: 'differs', quote: QUOTE });
    const claims = new ClaimChecker({ embed, judge, checker });
    const lead = passage(LEAD, 'encyclopedia:Treaty_of_Versailles');
    const first = await firstDiffers(claims, lead);
    const same = passage('The Treaty of Versailles was signed in 1919.', 'page:history', 'page', 'History');
    const other = passage('The Treaty of Versailles was signed in 1920.', 'page:other', 'page', 'Other');
    const sameSource = passage('The Treaty of Versailles was signed in 1919 in a hall of mirrors.', 'encyclopedia:Treaty_of_Versailles');
    expect(claims.agree(first, CLAIM, [same])).toEqual([same]);
    expect(claims.agree(first, CLAIM, [other])).toEqual([]);
    expect(claims.agree(first, CLAIM, [sameSource])).toEqual([]);
    expect(asked).toHaveLength(1);
  });
});
