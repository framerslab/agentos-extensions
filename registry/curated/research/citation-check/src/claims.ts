/**
 * @file claims.ts
 * @description A spoken claim checked against passages from any source: an encyclopedia article, a web page, a paper's
 * abstract, a person's own notes or documents. The grounding guard's checker keeps the sentences about the claim;
 * AgentOS's `CitationVerifier` names the best of them by cosine; one judge call, whose instruction, schema and quote
 * rule are this pack's, says whether that sentence matches the claim, differs from it, or neither; the judge's quote is
 * held to the sentence word for word (`verifyQuotes`); and the grounding guard decides by code over every passage
 * found, the ones never sent to a model among them. Passages that arrive after the first decision are decided by code
 * alone against it (`agree`), and a held "differs" is read again over every passage found by then (`revisit`).
 *
 * The host passes its embeddings call and its judge (`claimJudge` builds one on AgentOS's `generateObject`); the pack
 * reads no key from the environment.
 *
 * @module @framers/agentos-ext-citation-check/claims
 */

import type { ClaimVerdict } from '@framers/agentos';
import type { Decision, SourceSentence, ValueAgreementChecker } from '@framers/agentos-ext-grounding-guard';
import { collapse, fold, numberOf, words } from '@framers/agentos-ext-grounding-guard/values';
import { z } from 'zod';

/** The most words a judge's quote may hold. */
export const CLAIM_QUOTE_MAX_WORDS = 20;

/** A claim heard in a room: the words that hold it, the whole sentence they stand in, and the claim rewritten to stand alone. */
export interface SpokenClaim {
  /** The words heard that hold the claim, as they stand in `heardSentence`. */
  heard: string;
  /** The whole sentence the words stand in, whose negations all count. */
  heardSentence: string;
  /** The claim rewritten to stand alone, which the verifier compares with the passages. */
  statement: string;
}

/**
 * One sentence of a source, with the source it belongs to and what kind of source it is. Two passages of one `group`
 * are of one source (an article, a page, a note).
 */
export interface ClaimPassage {
  /** The sentence, its own characters. */
  content: string;
  /** The source's title, which the judge reads above the sentence; empty when it should not be sent. */
  title: string;
  /** The source's address, when it has one. */
  url?: string;
  /** The source the sentence belongs to. */
  group: string;
  /**
   * What kind of source it is, an open word: `encyclopedia`, `official`, `news`, `page`, `forum`, `paper`, `note`,
   * `document`, or any other. It chooses the judge's instruction ({@link claimJudgeSystem}).
   */
  kind: string;
}

/** The tokens a check used: the judge's in and out, and the embeddings' in. */
export interface ClaimUsage {
  judgeIn: number;
  judgeOut: number;
  embedIn: number;
}

/** What a judge answers about one sentence: the relation, and the words of the sentence it compared. */
export interface ClaimJudgement {
  relation: 'matches' | 'differs' | 'none';
  /** Copied from the sentence, at most {@link CLAIM_QUOTE_MAX_WORDS} words; empty for `none`. */
  quote: string;
}

/** The judge: one model call under `system` with `prompt`, ended by `signal`, answering the judgement and its tokens. */
export type ClaimJudge = (request: { system: string; prompt: string; signal: AbortSignal }) => Promise<{
  value: ClaimJudgement;
  usage: { in: number; out: number };
}>;

/** What a {@link ClaimChecker} is made with. */
export interface ClaimCheckerOptions {
  /** The host's embeddings call: one batch, one vector a text in order, and the tokens it used. */
  embed: (texts: string[], signal: AbortSignal) => Promise<{ vectors: number[][]; usage: { in: number } }>;
  /** The judge, such as {@link claimJudge}'s. */
  judge: ClaimJudge;
  /**
   * The grounding guard's `ValueAgreementChecker`, with `names` on for a stated fact that holds no value. `stems` is
   * read by {@link ClaimChecker.agree}.
   */
  checker: Pick<ValueAgreementChecker, 'passages' | 'decide' | 'stems'>;
  /** The most passages the verifier compares; 24 when left out. */
  maxPassages?: number;
}

/** The grounding guard's decision, its sentences the host's own passages. */
export type ClaimDecision<P extends ClaimPassage = ClaimPassage> = Omit<Decision, 'sentences'> & {
  /** The passages the relation rests on: one for "matches" and "differs", two for "disagree". */
  sentences: P[];
  /**
   * Each passage's text as the call read it, at the same index as `sentences`: the text `marks` and `pairs` index, and
   * the text that was compared, whatever the host has done to the passage since.
   */
  texts: string[];
};

/**
 * What a check came to: a decision, with the passage the verifier named, the judge's quote, the verifier's verdict, the
 * judge calls made and the tokens used; or why nothing may be shown.
 *
 * - `no_passage`: no passage given is about the claim; nothing was sent to a model;
 * - `no_best`: the verifier named no passage (no cosine above 0);
 * - `judge_none`: the judge answered `none`;
 * - `quote`: the judge's quote is empty, longer than {@link CLAIM_QUOTE_MAX_WORDS} words, or does not stand word for
 *   word in the sentence;
 * - `undecided`: the grounding guard's rule decided nothing, a passage found that agrees with every heard value among
 *   the reasons.
 */
export type ClaimCheckOutcome<P extends ClaimPassage = ClaimPassage> =
  | { kind: 'decided'; decision: ClaimDecision<P>; named: P; quote: string; verdict: ClaimVerdict; judged: number; usage: ClaimUsage }
  | { kind: 'ended'; reason: 'no_passage' | 'no_best' | 'judge_none' | 'quote' | 'undecided'; judged: number; usage: ClaimUsage };

/** A passage as the grounding guard's sentence, as the call read it, with the passage it stands for. */
interface PassageSentence<P extends ClaimPassage> extends SourceSentence {
  passage: P;
  title: string;
  kind: string;
  url: string | undefined;
}

/** The judge's instruction's words for a kind of source: what the sentence is from, and the title above it. */
function sourceWords(kind: string): { from: string; title: string } {
  switch (kind) {
    case 'encyclopedia':
      return { from: 'an encyclopedia article', title: "its article's title" };
    case 'official':
    case 'news':
    case 'page':
    case 'forum':
      return { from: 'a web page', title: "its page's title" };
    case 'paper':
      return { from: "a paper's abstract", title: "the paper's title" };
    case 'note':
    case 'document':
      return { from: "the person's own notes or documents", title: "its note's or document's title" };
    default:
      return { from: 'a source', title: "its source's title" };
  }
}

/**
 * The judge's instruction for a sentence from a source of this kind: whether the sentence states the same fact as the
 * claim (the same value, holder, place, maker or date), a different one, or neither, with the words it compared quoted
 * from the sentence. Every instruction opens with "You compare one sentence heard in a room with one sentence from",
 * then what the sentence is from: "an encyclopedia article" for `encyclopedia`; "a web page" for `official`, `news`,
 * `page` and `forum`; "a paper's abstract" for `paper`; "the person's own notes or documents" for `note` and
 * `document`; "a source" for any other word.
 *
 * @param kind - The named passage's kind ({@link ClaimPassage.kind}).
 */
export function claimJudgeSystem(kind: string): string {
  const source = sourceWords(kind);
  return [
    `You compare one sentence heard in a room with one sentence from ${source.from}.`,
    `HEARD is the sentence, transcribed by machine; it may be misheard. CHECK is the part being checked, rewritten to stand alone. SOURCE is that sentence, after ${source.title}.`,
    'relation "matches": SOURCE states the same fact for the same thing as CHECK: the same value, holder, place, maker or date, holding at the same time.',
    'relation "differs": SOURCE states a different value, holder, place, maker or date for the same thing as CHECK, or says it held only in the past while CHECK says it holds now.',
    'relation "none": everything else, including a sentence about something else, and a HEARD that is an opinion, a plan, a question, a joke or a hypothetical. When unsure, "none".',
    `quote: copied character for character from SOURCE, at most ${CLAIM_QUOTE_MAX_WORDS} words, holding the words that state the fact you compared; empty for "none".`,
    'Use no knowledge beyond SOURCE and HEARD. Never judge the speaker.',
  ].join('\n');
}

/**
 * The judge's prompt: the heard sentence, the claim, and the one sentence with its source's title above it.
 *
 * @param heard - The whole sentence heard.
 * @param statement - The claim rewritten to stand alone.
 * @param title - The source's title; empty when it should not be sent.
 * @param sentence - The source's sentence.
 */
export function claimJudgePrompt(heard: string, statement: string, title: string, sentence: string): string {
  return `HEARD: ${heard}\nCHECK: ${statement}\nSOURCE: ${title}\n${sentence}`;
}

/** The judge's answer's schema. */
const CLAIM_JUDGEMENT = z.object({
  relation: z.enum(['matches', 'differs', 'none']),
  quote: z.string().describe(`Copied from SOURCE, at most ${CLAIM_QUOTE_MAX_WORDS} words; empty for none.`),
});

/** `work`'s outcome, or a rejection with the signal's reason the moment the signal aborts first. */
function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Nobody waits for `work` now, so its own rejection is handled here.
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * A judge on AgentOS's `generateObject`, with this pack's schema: one call, sent once (`maxAttempts: 1`), with no
 * second call for an answer that is not the schema (`maxRetries: 0`) and no other provider (`fallbackProviders: []`),
 * ended at `deadlineMs` or by the caller's signal, whichever comes first, the body's read included.
 *
 * @param options - The model (`provider:model`, such as `openai:gpt-6-luna`), the key, the base address (a stand-in in
 * a host's tests), each call's deadline, the most tokens it may answer, and the reasoning effort for a model that takes
 * one.
 * @returns The judge. It rejects with the caller's reason when the caller's signal aborts, with a timeout when the
 * deadline passes, and with the provider's error otherwise.
 */
export function claimJudge(options: {
  model: string;
  apiKey: string;
  baseUrl?: string;
  deadlineMs: number;
  maxOutputTokens: number;
  effort?: string;
}): ClaimJudge {
  return async ({ system, prompt, signal }) => {
    signal.throwIfAborted();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(options.deadlineMs)]);
    const call = (async () => {
      const { generateObject } = await import('@framers/agentos');
      return generateObject({
        model: options.model,
        schema: CLAIM_JUDGEMENT,
        schemaName: 'judgement',
        system,
        prompt,
        maxTokens: options.maxOutputTokens,
        maxRetries: 0,
        maxAttempts: 1,
        fallbackProviders: [],
        requestTimeout: options.deadlineMs,
        abortSignal: bounded,
        apiKey: options.apiKey,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.effort === undefined ? {} : { effort: options.effort }),
      });
    })();
    const result = await untilAbort(call, bounded);
    return {
      value: { relation: result.object.relation, quote: result.object.quote },
      usage: { in: result.usage.promptTokens ?? 0, out: result.usage.completionTokens ?? 0 },
    };
  };
}

/**
 * One call's sentences: each passage read once, when the call first meets it, so everything the call sends or decides on
 * is the passage as it was then, whatever another call or the host does to it meanwhile, and one passage is one sentence
 * within the call.
 */
function snapshot(): <P extends ClaimPassage>(passage: P) => PassageSentence<P> {
  const sentences = new Map<ClaimPassage, PassageSentence<ClaimPassage>>();
  return <P extends ClaimPassage>(passage: P): PassageSentence<P> => {
    let sentence = sentences.get(passage);
    if (sentence === undefined) {
      sentence = { text: passage.content, group: passage.group, title: passage.title, kind: passage.kind, url: passage.url, passage };
      sentences.set(passage, sentence);
    }
    return sentence as PassageSentence<P>;
  };
}

/** `a`, then each of `b` not in it. */
function unite<T>(a: readonly T[], b: readonly T[]): T[] {
  const seen = new Set(a);
  return [...a, ...b.filter((item) => !seen.has(item))];
}

/** The characters of a span, or empty for none or one out of range. */
function spanText(text: string, span: { start: number; end: number } | null | undefined): string {
  if (span === null || span === undefined) return '';
  const { start, end } = span;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= text.length && start < end ? text.slice(start, end) : '';
}

/** Two marked values the same as written: their characters equal once white space and thousands separators are read alike. */
function sameAsWritten(a: string, b: string): boolean {
  return a !== '' && b !== '' && numberOf(collapse(a)) === numberOf(collapse(b));
}

/** The grounding guard's `verifyQuotes`, as this module calls it. */
type VerifyQuotes = (quotes: ReadonlyArray<{ text: string; sourceIndex: number }>, sources: readonly string[], options: { normalize: (text: string) => string }) => Array<{ found: boolean }>;

/** Whether a judgement's quote may stand: a relation, one to {@link CLAIM_QUOTE_MAX_WORDS} words, word for word in the sentence. */
function quoteHolds(value: ClaimJudgement, sentence: string, verifyQuotes: VerifyQuotes): boolean {
  if (value.relation === 'none') return false;
  const count = words(value.quote).length;
  return count >= 1 && count <= CLAIM_QUOTE_MAX_WORDS && verifyQuotes([{ text: value.quote, sourceIndex: 0 }], [sentence], { normalize: fold })[0]?.found === true;
}

/**
 * Checks spoken claims against passages from any source, as `check` says, and decides later passages by code against a
 * first decision. One checker serves many checks: it keeps nothing of a check but what `agree` and `revisit` read
 * again, held weakly by the outcome `check` answered.
 *
 * @example
 * ```ts
 * import { ClaimChecker, claimJudge } from '@framers/agentos-ext-citation-check';
 * import { ValueAgreementChecker } from '@framers/agentos-ext-grounding-guard';
 *
 * const checker = new ClaimChecker({
 *   embed: async (texts, signal) => myEmbeddings(texts, signal), // { vectors, usage: { in } }
 *   judge: claimJudge({ model: 'openai:gpt-6-luna', apiKey, deadlineMs: 8_000, maxOutputTokens: 400 }),
 *   checker: new ValueAgreementChecker({ names: true }),
 * });
 * const outcome = await checker.check(
 *   { heard, heardSentence, statement },
 *   passages, // ClaimPassage[]: { content, title, url?, group, kind }
 *   { signal },
 * );
 * ```
 */
export class ClaimChecker {
  private readonly embed: ClaimCheckerOptions['embed'];
  private readonly judge: ClaimJudge;
  private readonly checker: ClaimCheckerOptions['checker'];
  private readonly maxPassages: number;
  /**
   * What a decided check keeps for `agree` and `revisit`, by the outcome `check` answered: every passage it found, the
   * held-back ones among them.
   */
  private readonly decided = new WeakMap<object, { found: ClaimPassage[] }>();
  /**
   * The texts each decision this checker answered was decided on, by the decision (`check`'s and `revisit`'s alike),
   * which the host's copy in `decision.texts` may since have been changed from.
   */
  private readonly decisionTexts = new WeakMap<object, readonly string[]>();

  /**
   * @param options - The embeddings call, the judge, the grounding guard's checker, and the most passages compared.
   * @throws {RangeError} For a `maxPassages` that is not a whole number of at least 1.
   */
  constructor(options: ClaimCheckerOptions) {
    const maxPassages = options.maxPassages ?? 24;
    if (!Number.isInteger(maxPassages) || maxPassages < 1) throw new RangeError(`maxPassages must be a whole number of at least 1, not ${maxPassages}`);
    this.embed = options.embed;
    this.judge = options.judge;
    this.checker = options.checker;
    this.maxPassages = maxPassages;
  }

  /** A decision with the host's passages in place of the grounding guard's sentences, and their texts as read. */
  private toHost<P extends ClaimPassage>(decision: Decision): ClaimDecision<P> {
    const texts = decision.sentences.map((sentence) => sentence.text);
    const host: ClaimDecision<P> = {
      ...decision,
      sentences: decision.sentences.map((sentence) => (sentence as PassageSentence<P>).passage),
      texts: [...texts],
    };
    this.decisionTexts.set(host, texts);
    return host;
  }

  /** Every passage found for a decided check; the decision's own passages when the outcome is not one `check` answered. */
  private foundOf<P extends ClaimPassage>(first: Extract<ClaimCheckOutcome<P>, { kind: 'decided' }>): P[] {
    const kept = this.decided.get(first)?.found as P[] | undefined;
    return kept ?? unite(first.decision.sentences, [first.named]);
  }

  /**
   * Checks a claim against passages, in order:
   *
   * 1. the grounding guard's `passages` keeps the sentences of `given` about the claim; none ends `no_passage`, with
   *    nothing sent anywhere;
   * 2. AgentOS's `CitationVerifier`, both its thresholds 0 and its `embedFn` the host's `embed` (one call for the claim
   *    and the first `maxPassages` sentences kept), names the best of them by cosine; none ends `no_best`;
   * 3. the judge is asked once about that sentence, under {@link claimJudgeSystem} for its kind, with
   *    {@link claimJudgePrompt}; `none` ends `judge_none`;
   * 4. the judge's quote must hold one to {@link CLAIM_QUOTE_MAX_WORDS} words and stand in the sentence word for word
   *    (`verifyQuotes` with `fold`); else it ends `quote`;
   * 5. the grounding guard's `decide` takes the judge's relation as its proposal, the named sentence, the quote, and as
   *    `found` every sentence kept in step 1 and every one of `options.found`; `null` ends `undecided`.
   *
   * `options.found` is every passage about the claim the host holds, the ones it may not send included (a sentence that
   * holds personal data, for example): they are never embedded, judged or sent, and take part in step 5 alone, where a
   * passage that agrees with every heard value stops a "differs". Left out, it is `given`'s sentences about the claim.
   *
   * @param claim - The claim heard.
   * @param given - The passages that may be sent to the embeddings and the judge.
   * @param options - The check's signal, and every passage found.
   * @throws The signal's reason when it aborts, at once, whatever is pending; the embeddings' or the judge's error as it
   * came, which the verifier alone would have swallowed.
   */
  async check<P extends ClaimPassage>(claim: SpokenClaim, given: readonly P[], options: { signal: AbortSignal; found?: readonly P[] }): Promise<ClaimCheckOutcome<P>> {
    const { signal } = options;
    signal.throwIfAborted();
    const usage: ClaimUsage = { judgeIn: 0, judgeOut: 0, embedIn: 0 };
    const state: { judged: number; judgement: { value: ClaimJudgement; holds: boolean } | null; failure: { error: unknown } | null } = {
      judged: 0,
      judgement: null,
      failure: null,
    };
    const ended = (reason: Extract<ClaimCheckOutcome<P>, { kind: 'ended' }>['reason']): ClaimCheckOutcome<P> => ({
      kind: 'ended',
      reason,
      judged: state.judged,
      usage: { ...usage },
    });

    // The passages as they are now: this call reads nothing of them later.
    const sentenceOf = snapshot();
    // 1. The sentences about the claim that may be sent.
    const kept = this.checker.passages(claim.heard, given.map((passage) => sentenceOf(passage))).found;
    if (kept.length === 0) return ended('no_passage');
    const compared = kept.slice(0, this.maxPassages);
    const found = unite(kept, (options.found ?? []).map((passage) => sentenceOf(passage)));

    // The title and the kind the judge reads, by the sentence the verifier hands its NLI function: a text two passages
    // of different titles or kinds share reads as no title, and as a source of no known kind.
    const about = new Map<string, { title: string; kind: string }>();
    for (const sentence of compared) {
      const known = about.get(sentence.text);
      const { title, kind } = sentence;
      about.set(sentence.text, known === undefined ? { title, kind } : { title: known.title === title ? title : '', kind: known.kind === kind ? kind : '' });
    }

    const [{ CitationVerifier }, { verifyQuotes }] = await untilAbort(
      Promise.all([import('@framers/agentos/cognition/rag/citation/index'), import('@framers/agentos-ext-grounding-guard')]),
      signal,
    );
    const verifier = new CitationVerifier({
      // The cosine names the best passage and decides nothing: the judge and the grounding guard's rule decide.
      supportThreshold: 0,
      unverifiableThreshold: 0,
      embedFn: async (texts) => {
        signal.throwIfAborted();
        const embedded = await this.embed(texts, signal);
        usage.embedIn += embedded.usage.in;
        if (embedded.vectors.length !== texts.length) {
          throw new Error(`the embeddings answered ${embedded.vectors.length} vectors for ${texts.length} texts`);
        }
        return embedded.vectors;
      },
      // The verifier keeps its cosine verdict when its NLI function throws, so a judge that failed is held here and
      // thrown after `verify`, as the embeddings' failure is.
      nliFn: async (premise, hypothesis) => {
        try {
          signal.throwIfAborted();
          const source = about.get(premise) ?? { title: '', kind: '' };
          state.judged += 1;
          const answer = await this.judge({
            system: claimJudgeSystem(source.kind),
            prompt: claimJudgePrompt(claim.heardSentence, hypothesis, source.title, premise),
            signal,
          });
          usage.judgeIn += answer.usage.in;
          usage.judgeOut += answer.usage.out;
          const holds = quoteHolds(answer.value, premise, verifyQuotes as VerifyQuotes);
          state.judgement = { value: answer.value, holds };
          if (answer.value.relation === 'none' || !holds) return { label: 'neutral' as const, score: 0 };
          return { label: answer.value.relation === 'matches' ? ('entailment' as const) : ('contradiction' as const), score: 1 };
        } catch (error) {
          state.failure = { error };
          throw error;
        }
      },
    });

    // 2 and 3: the verifier's best, and the judge on it.
    const verified = await untilAbort(
      verifier.verify(
        [claim.statement],
        compared.map((sentence) => ({ content: sentence.text, title: sentence.title, ...(sentence.url === undefined ? {} : { url: sentence.url }) })),
      ),
      signal,
    );
    if (state.failure !== null) throw state.failure.error;
    signal.throwIfAborted();
    const verdict = verified.claims[0];
    const named = verdict?.sourceIndex === undefined ? undefined : compared[verdict.sourceIndex];
    if (verdict === undefined || named === undefined) return ended('no_best');
    const judgement = state.judgement;
    if (judgement === null || judgement.value.relation === 'none') return ended('judge_none');
    // 4. The quote.
    if (!judgement.holds) return ended('quote');
    // 5. The rule, by code, over every passage found.
    const decision = this.checker.decide({
      heardWords: claim.heard,
      heardSentence: claim.heardSentence,
      proposed: judgement.value.relation,
      named: [named],
      found,
      quote: judgement.value.quote,
    });
    if (decision === null) return ended('undecided');
    const outcome: Extract<ClaimCheckOutcome<P>, { kind: 'decided' }> = {
      kind: 'decided',
      decision: this.toHost<P>(decision),
      named: named.passage,
      quote: judgement.value.quote,
      verdict,
      judged: state.judged,
      usage: { ...usage },
    };
    this.decided.set(outcome, { found: found.map((sentence) => sentence.passage) });
    return outcome;
  }

  /**
   * The passages that arrived after a first decision and agree with it, decided by code alone, with no model call. Each
   * source of `more` (by `group`) other than the first decision's is read once, by its passage the grounding guard
   * ranks first about the claim, which joins when:
   *
   * 1. it holds every content stem of the heard words;
   * 2. the grounding guard decides the first decision's relation for it, on the values, over every passage found (the
   *    first check's and every one of `more`, whatever its length);
   * 3. its first value pair pairs the same heard value as the first decision's;
   * 4. for a "differs", its marked value is the first decision's as written; for a "matches", each of the first
   *    decision's pairs finds its partner written alike, the decision's sentence read as the call that answered it
   *    (`check`, or `revisit` for a decision the host put in the outcome's place) read it, whatever the host has
   *    written into `decision.texts` since.
   *
   * A "disagree", a decision on the judge's quote alone, and a decision with no value pair take no passage.
   *
   * @param first - The decided outcome `check` answered.
   * @param claim - The claim it checked.
   * @param more - The later passages.
   * @returns The passages that join, in the grounding guard's order.
   */
  agree<P extends ClaimPassage>(first: Extract<ClaimCheckOutcome<P>, { kind: 'decided' }>, claim: SpokenClaim, more: readonly P[]): P[] {
    const { decision } = first;
    if (decision.relation === 'disagree' || decision.basis !== 'values') return [];
    const firstPairs = Array.isArray(decision.pairs) ? decision.pairs : [];
    const lead = firstPairs[0];
    if (lead === undefined) return [];
    // The decision's marks and pairs are offsets into its sentence as it was decided: the text kept for a decision this
    // checker answered (`check`'s, or `revisit`'s the host put in its place), whatever the host has written into
    // `decision.texts` since.
    const firstSentence = this.decisionTexts.get(decision)?.[0] ?? decision.texts?.[0] ?? (decision.sentences[0] ?? first.named).content;
    // Every passage as it is now, the first check's included (a host may have changed one since).
    const sentenceOf = snapshot();
    const later = more.map((passage) => sentenceOf(passage));
    // The passages that may join are those about the claim; the veto reads every passage, as `check`'s `found`.
    const candidates = this.checker.passages(claim.heard, later).found;
    const found = unite(this.foundOf(first).map((passage) => sentenceOf(passage)), later);
    const heardStems = this.checker.stems(claim.heard);
    const considered = new Set(decision.sentences.map((passage) => passage.group));
    const joined: P[] = [];
    for (const sentence of candidates) {
      if (considered.has(sentence.group)) continue;
      // Each other source once: its best-ranked passage stands for it.
      considered.add(sentence.group);
      const own = this.checker.stems(sentence.text);
      if (![...heardStems].every((stem) => own.has(stem))) continue;
      const decided = this.checker.decide({ heardWords: claim.heard, heardSentence: claim.heardSentence, proposed: decision.relation, named: [sentence], found });
      if (decided === null || decided.relation !== decision.relation || decided.basis !== 'values') continue;
      const pairs = Array.isArray(decided.pairs) ? decided.pairs : [];
      const other = pairs[0];
      if (other === undefined || other.heard.start !== lead.heard.start || other.heard.end !== lead.heard.end) continue;
      const same =
        decision.relation === 'differs'
          ? sameAsWritten(spanText(firstSentence, decision.marks[0]), spanText(sentence.text, decided.marks[0]))
          : firstPairs.every((pair) => {
              const at = pairs.find((candidate) => candidate.heard.start === pair.heard.start && candidate.heard.end === pair.heard.end);
              return at !== undefined && sameAsWritten(spanText(firstSentence, pair.source), spanText(sentence.text, at.source));
            });
      if (same) joined.push(sentence.passage);
    }
    return joined;
  }

  /**
   * The first decision read again over every passage found by then: the grounding guard's rule with the same proposal,
   * named passage and quote, its `found` every passage the check found (held-back ones among them) and every passage of
   * `found`, as `check` reads its own `found`, whatever its length. A "differs" a later passage stops (one that agrees with every heard value) answers `null`,
   * so a host that holds a "differs" until its slower sources have answered shows nothing.
   *
   * @param first - The decided outcome `check` answered.
   * @param claim - The claim it checked.
   * @param found - Every passage found by then.
   * @returns The decision, its relation the first's, or `null`.
   */
  revisit<P extends ClaimPassage>(first: Extract<ClaimCheckOutcome<P>, { kind: 'decided' }>, claim: SpokenClaim, found: readonly P[]): ClaimDecision<P> | null {
    const { decision } = first;
    // Every passage as it is now, the first check's included; none is held to the sentence limits a passage the judge
    // reads is, as `check`'s `found`.
    const sentenceOf = snapshot();
    const named = decision.relation === 'disagree' ? decision.sentences.map((passage) => sentenceOf(passage)) : [sentenceOf(first.named)];
    const all = unite(unite(named, this.foundOf(first).map((passage) => sentenceOf(passage))), found.map((passage) => sentenceOf(passage)));
    const again = this.checker.decide({ heardWords: claim.heard, heardSentence: claim.heardSentence, proposed: decision.relation, named, found: all, quote: first.quote });
    if (again === null || again.relation !== decision.relation) return null;
    return this.toHost<P>(again);
  }
}
