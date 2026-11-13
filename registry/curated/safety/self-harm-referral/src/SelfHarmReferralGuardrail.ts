/**
 * @fileoverview The self-harm referral guard: an input and output guardrail that answers a self-harm expression with
 * crisis lines and reports each referral to its host.
 *
 * Reply delivery (the default): on a person's message (input) or an agent's final reply (output), it matches the
 * reviewed keyword list over the normalised text; a match goes to the judge when one is configured, and a match the judge does not clear is answered
 * with the referral: a BLOCK whose `replacementText` (and `reason`) is the referral's text, so the topic does not go
 * on, and a `referral_sent` event for the host to count. The guard fails toward the referral: a judge that throws,
 * times out, answers nothing usable or clears a match with too little confidence leaves the referral standing.
 *
 * Private delivery requires a judge, evaluates input alone and returns FLAG: a confirmed match carries a referral
 * for the host to deliver to the speaker alone; an unconfirmed match carries no referral.
 *
 * @module @framers/agentos-ext-self-harm-referral/SelfHarmReferralGuardrail
 */

import type { ILogger } from '@framers/agentos';
import {
  GuardrailAction,
  createLlmPhraseJudge,
  phraseMatches,
  type GuardrailConfig,
  type GuardrailContext,
  type GuardrailEvaluationResult,
  type GuardrailInputPayload,
  type GuardrailOutputPayload,
  type IGuardrailService,
  type PhraseEntry,
  type PhraseJudge,
} from '@framers/agentos/safety/guardrails';

import { REPLY_PHRASES, SELF_HARM_PHRASES, SELF_HARM_PHRASES_VERSION } from './phrases.js';
import { REFERRAL_TABLE, buildReferral, privateReferralFor, resolvePlace, type PlaceHint, type ReferralPlace } from './referrals.js';
import type {
  DetectionMethod,
  JudgeOutcome,
  ReferralSentEvent,
  ReferralStage,
  ReferralTable,
  SelfHarmReferralOptions,
} from './types.js';

/** The guard's id when the host names none. */
export const DEFAULT_GUARDRAIL_ID = 'self-harm-referral';

/** The reason code on every referral verdict. */
export const REFERRAL_REASON_CODE = 'SELF_HARM_REFERRAL';

/**
 * The reason code of a `private`-mode match that sent no referral: the judge was unsure (a clearing or a confirmation
 * below the threshold), failed, or no person could be named to send it to.
 */
export const UNCONFIRMED_REASON_CODE = 'SELF_HARM_UNCONFIRMED';

/** The codes the guard answers with, for its `config.reasonCodes`. */
const REASON_CODES: readonly string[] = Object.freeze([REFERRAL_REASON_CODE, UNCONFIRMED_REASON_CODE]);

/** The judge's confidence at or above which its clearing of a match counts, when the host sets none. */
export const DEFAULT_JUDGE_THRESHOLD = 0.7;

/** How long the judge may take, when the host sets no limit. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 6_000;

/**
 * In `private` delivery the guard's own deadline (`config.timeoutMs`) is the judge's plus this margin, so the judge's
 * deadline always ends first and the guard answers its flag: a moderation call's shorter default deadline would
 * otherwise drop a guard that runs open, and the item would pass with no flag for a person.
 */
const PRIVATE_DEADLINE_MARGIN_MS = 1_000;

/**
 * What the model judge is asked to decide about a keyword match. The judge blocks (`block: true`) when the text calls
 * for a crisis referral, and clears figurative, title and factual uses.
 */
export const SELF_HARM_JUDGE_CRITERIA = [
  'The text calls for a crisis referral when, read in context, it is about suicide or self-harm in one of these ways:',
  '- the writer says they think about, plan, intend or want to end their life, die, or hurt or injure themselves, or that they have done so or keep doing so;',
  '- the writer asks for methods, means, places, amounts or ways to do so, including how much of a substance or how far a fall would kill a person, unless the text states another purpose;',
  "- an assistant's reply describes, encourages or gives information about ways to die or to hurt oneself, or carries on a conversation about the reader's own thoughts of suicide or self-harm.",
  'It does not when the words are figurative or idiomatic ("I could kill myself laughing", "I cut myself shaving"),',
  'describe an accident ("I burned myself on the stove"), end something other than a life ("I want to end it with my boyfriend"),',
  'are about plans or a game ("I can\'t go on Friday", "how do I die in this level", "I want to jump off the cliff into the lake"),',
  'name a film, book, song or game, or mention suicide or self-harm as a fact, in history, news, research or fiction,',
  "with nothing about the writer's or the reader's own risk.",
  'Answer block: true when the text calls for a crisis referral, block: false when it does not.',
].join('\n');

/** The final reply chunk's type string in AgentOS (`AgentOSResponseChunkType.FINAL_RESPONSE`). */
const FINAL_RESPONSE = 'final_response';

/** A logger that writes nothing, for a guard built with none. */
const SILENT: ILogger = { info() {}, warn() {}, error() {} };

/**
 * Who a private referral is for: the room message's sender when the context names one, else the user the call runs
 * for. A context that names a sender has said the writer is not that user, so a sender that is an agent or has no
 * usable id gives no recipient, never the user.
 */
function recipientOf(context: GuardrailContext | undefined): string | undefined {
  // Read without the type of a newer core, so the pack builds and runs on every core its peer floor names
  const sender = (context as { moderation?: { sender?: { id?: unknown; kind?: unknown } | null } } | undefined)?.moderation?.sender;
  if (sender !== undefined && sender !== null) {
    if (sender.kind === 'agent') return undefined;
    const id = sender.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  }
  const userId = context?.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : undefined;
}

/** What the judge decided about a match, and whether the referral stands. */
interface JudgeResult {
  refer: boolean;
  method: DetectionMethod;
  outcome: JudgeOutcome;
}

/**
 * The guard. Build it with {@link SelfHarmReferralOptions}. Private delivery flags input for the host to handle.
 * Reply delivery runs in AgentOS's first, sequential phase, so its BLOCK
 * ends the turn before any classifier runs; register it first, since a sanitizer registered before it that blocks
 * answers in its place.
 */
export class SelfHarmReferralGuardrail implements IGuardrailService {
  /** The guard's id, on its descriptor and its verdicts. */
  readonly id: string;
  /** The stages it evaluates. */
  readonly stages: ReadonlyArray<ReferralStage>;
  /**
   * In `reply` mode: final replies only. `canSanitize` puts the guard in AgentOS's first phase, though it never returns
   * SANITIZE: guards in that phase run one at a time and a BLOCK there ends the evaluation, while the second phase runs
   * every classifier and answers with the first BLOCK in registration order, which could take the answer from a
   * referral the guard had already reported. An ordinary text costs nothing there: the list reads it and the guard
   * returns null. `failClosed` turns an unexpected throw into a block; the guard's own judge deadline keeps a slow
   * judge from reaching it.
   *
   * In `private` mode it never answers the turn, so it needs no first phase, and a fault inside it never refuses a
   * room message: `canSanitize` and `failClosed` are false. Its `timeoutMs` is the judge's deadline plus a second, so
   * a caller's shorter deadline never drops it before its judge's deadline makes it flag the item.
   */
  readonly config: GuardrailConfig;
  /** How a referral reaches the person: `reply` or `private`. */
  readonly delivery: 'reply' | 'private';

  private readonly table: ReferralTable;
  private readonly judge: PhraseJudge | undefined;
  private readonly judgeThreshold: number;
  private readonly judgeTimeoutMs: number;
  private readonly inputPhrases: PhraseEntry[];
  private readonly outputPhrases: PhraseEntry[];
  private readonly logger: ILogger;
  private readonly now: () => number;
  private sent = 0;

  /**
   * Builds the guard.
   *
   * @param options - How the host wants it; every field is optional.
   * @throws Error when the table names no lines for its `always` country, when a phrase does not compile, or when
   * `judgeModel` pins a provider other than `openai` with no model: a host hears of each when it builds the guard, not
   * on a person's message. Private delivery also requires a judge and forbids the output stage.
   */
  constructor(private readonly options: SelfHarmReferralOptions = {}) {
    this.id = options.id ?? DEFAULT_GUARDRAIL_ID;
    this.delivery = options.delivery ?? 'reply';
    if (this.delivery !== 'reply' && this.delivery !== 'private') {
      throw new Error(`${this.id}: delivery must be "reply" or "private"`);
    }
    if (this.delivery === 'private') {
      // No judge, no confirmation, and in a room no referral without one
      if (!options.judge && !options.judgeModel) {
        throw new Error(`${this.id}: private delivery needs a judge or a judgeModel; it sends no referral without a judge's confirmation`);
      }
      if (options.stages?.includes('output')) {
        throw new Error(`${this.id}: private delivery evaluates a person's message alone; its stages cannot name output`);
      }
    }
    this.stages = [...(options.stages ?? (this.delivery === 'private' ? ['input'] : ['input', 'output']))];
    const judgeTimeoutMs = options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
    // A deadline that outlasts the judge's, so the guard answers its flag before a caller's deadline drops it
    const ownDeadline = Number.isFinite(judgeTimeoutMs) && judgeTimeoutMs >= 0 ? { timeoutMs: judgeTimeoutMs + PRIVATE_DEADLINE_MARGIN_MS } : {};
    this.config = this.delivery === 'private'
      ? { canSanitize: false, evaluateStreamingChunks: false, failClosed: false, ...ownDeadline, reasonCodes: REASON_CODES }
      : { canSanitize: true, evaluateStreamingChunks: false, failClosed: true, reasonCodes: REASON_CODES };
    this.table = options.table ?? REFERRAL_TABLE;
    if (!this.table.countries[this.table.always]) {
      throw new Error(`${this.id}: the referral table names no lines for its "always" country ${this.table.always}`);
    }
    this.judge =
      options.judge ??
      (options.judgeModel
        ? createLlmPhraseJudge({
            ...options.judgeModel,
            criteria: SELF_HARM_JUDGE_CRITERIA,
            timeoutMs: judgeTimeoutMs,
          })
        : undefined);
    this.judgeThreshold = options.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
    this.judgeTimeoutMs = judgeTimeoutMs;
    const extra = options.extraPhrases ?? [];
    this.inputPhrases = [...SELF_HARM_PHRASES, ...extra];
    this.outputPhrases = [...SELF_HARM_PHRASES, ...REPLY_PHRASES, ...extra];
    // A list that does not compile fails here, when the host builds the guard, not on a person's message.
    phraseMatches(this.outputPhrases, '');
    this.logger = options.logger ?? SILENT;
    this.now = options.now ?? Date.now;
  }

  /** How many referrals this guard has sent since it was built. */
  get referralsSent(): number {
    return this.sent;
  }

  /** Evaluates a person's message: a replacement in reply mode, or a flag in private mode. */
  async evaluateInput(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    if (!this.stages.includes('input')) return null;
    const text = payload?.input?.textInput;
    if (typeof text !== 'string' || !text.trim()) return null;
    const context = payload.context;
    const hints: PlaceHint[] = [
      { country: context?.metadata?.country },
      { locale: context?.metadata?.locale },
      { locale: payload.input.languageHint },
      ...this.defaultPlace(),
    ];
    if (this.delivery === 'private') return this.evaluatePrivately(text, context, hints);
    return this.evaluate('input', text, this.inputPhrases, context, hints);
  }

  /** Replaces an agent's final reply that carries the topic on with the referral. */
  async evaluateOutput(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (!this.stages.includes('output')) return null;
    const chunk = payload?.chunk as { type?: unknown; finalResponseText?: unknown } | undefined;
    // A final reply; a host that hands over the reply's text alone, with no chunk type, is read the same way.
    if (!chunk || (chunk.type !== undefined && chunk.type !== FINAL_RESPONSE)) return null;
    const text = chunk.finalResponseText;
    if (typeof text !== 'string' || !text.trim()) return null;
    const context = payload.context;
    return this.evaluate('output', text, this.outputPhrases, context, [
      { country: context?.metadata?.country },
      { locale: context?.metadata?.locale },
      ...this.defaultPlace(),
    ]);
  }

  /**
   * Hands the event to the host without waiting on it: a handler that throws, rejects or never settles cannot hold
   * the referral back. A synchronous handler has the event before the verdict returns.
   */
  private emit(event: ReferralSentEvent): void {
    const onEvent = this.options.onEvent;
    if (!onEvent) return;
    // A callback controls its error name as well as its message; neither belongs in a log.
    const failed = () =>
      this.log('warn', 'self-harm-referral: the host event handler failed; the referral is sent', {
        guardrailId: this.id,
        stage: event.stage,
        errorName: 'unknown',
      });
    try {
      const pending = onEvent(event);
      if (pending && typeof (pending as PromiseLike<void>).then === 'function') {
        (pending as PromiseLike<void>).then(undefined, failed);
      }
    } catch {
      failed();
    }
  }

  /** Writes a line through the host's logger; a logger that throws never stops a referral. */
  private log(level: 'info' | 'warn', message: string, meta: Record<string, unknown>): void {
    try {
      this.logger[level](message, meta);
    } catch {
      // The referral matters more than its log line.
    }
  }

  /** The place the pack's options name, read after whatever the turn names. */
  private defaultPlace(): PlaceHint[] {
    return [{ country: this.options.country }, { locale: this.options.locale }];
  }

  /** Matches the text against the list, asks the judge about a match, and answers with the referral unless it was cleared. */
  private async evaluate(
    stage: ReferralStage,
    text: string,
    phrases: readonly PhraseEntry[],
    context: GuardrailContext | undefined,
    hints: PlaceHint[],
  ): Promise<GuardrailEvaluationResult | null> {
    const matched = phraseMatches(phrases, text);
    if (matched.length === 0) return null;
    const verdict = await this.ask(text, matched, context, stage);
    if (!verdict.refer) return null;
    return this.refer(stage, context, hints, verdict);
  }

  /** Asks the judge about a match, within the deadline; any answer but a confident clearing keeps the referral. */
  private async ask(
    text: string,
    matched: PhraseEntry[],
    context: GuardrailContext | undefined,
    stage: ReferralStage,
  ): Promise<JudgeResult> {
    if (!this.judge) return { refer: true, method: 'keyword', outcome: 'none' };
    const judgeContext: GuardrailContext = context ?? { userId: '', sessionId: '' };
    const timedOut = Symbol('timed out');
    let timer: ReturnType<typeof setTimeout> | undefined;
    // In reply mode an unanswered judge leaves the referral standing; in private mode it sends none
    const after = this.delivery === 'private' ? 'no referral is sent' : 'the referral stands';
    try {
      const deadline = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), this.judgeTimeoutMs);
      });
      const verdict = await Promise.race([this.judge.judge(text, matched, judgeContext), deadline]);
      if (verdict === timedOut) {
        this.log('warn', `self-harm-referral: judge timed out; ${after}`, { guardrailId: this.id, stage, timeoutMs: this.judgeTimeoutMs });
        return { refer: true, method: 'keyword_and_judge', outcome: 'failed' };
      }
      const usable =
        verdict && typeof verdict.block === 'boolean' && typeof verdict.confidence === 'number' && Number.isFinite(verdict.confidence);
      if (!usable) {
        this.log('warn', `self-harm-referral: judge gave no usable answer; ${after}`, { guardrailId: this.id, stage });
        return { refer: true, method: 'keyword_and_judge', outcome: 'failed' };
      }
      if (verdict.block) {
        // In private mode the threshold bounds a confirmation as it bounds a clearing: a weak one sends nothing
        const weak = this.delivery === 'private' && verdict.confidence < this.judgeThreshold;
        return { refer: true, method: 'keyword_and_judge', outcome: weak ? 'unsure' : 'confirmed' };
      }
      if (verdict.confidence < this.judgeThreshold) return { refer: true, method: 'keyword_and_judge', outcome: 'unsure' };
      // A clearing withholds a referral and leaves no event, so this line is what there is to audit. The judge's reason
      // is left out, since it can repeat the text it was given.
      this.log('info', 'self-harm-referral: judge cleared a match; no referral', {
        guardrailId: this.id,
        stage,
        judgeOutcome: 'cleared',
        confidence: verdict.confidence,
      });
      return { refer: false, method: 'keyword_and_judge', outcome: 'none' };
    } catch {
      // Both the error's name and message can repeat the text given to the judge or provider.
      this.log('warn', `self-harm-referral: judge failed; ${after}`, {
        guardrailId: this.id,
        stage,
        errorName: 'unknown',
      });
      return { refer: true, method: 'keyword_and_judge', outcome: 'failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Builds the referral for the turn's place, counts it, logs it, reports it, and returns the verdict that sends it. */
  private refer(
    stage: ReferralStage,
    context: GuardrailContext | undefined,
    hints: PlaceHint[],
    verdict: JudgeResult,
  ): GuardrailEvaluationResult {
    const place = resolvePlace(this.table, hints);
    const referral = buildReferral(this.table, place.country);
    const lineIds = referral.lines.map((line) => line.id);
    const sessionId = context?.sessionId;
    const conversationId = context?.conversationId;
    const event: ReferralSentEvent = {
      type: 'referral_sent',
      guardrailId: this.id,
      stage,
      country: place.country,
      locale: place.locale,
      lineIds,
      method: verdict.method,
      judgeOutcome: verdict.outcome,
      tableVersion: this.table.version,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      conversationId: typeof conversationId === 'string' && conversationId ? conversationId : null,
      occurredAt: new Date(this.now()).toISOString(),
    };
    this.sent += 1;
    // One line per referral, with no words of the person's or the agent's.
    this.log('info', 'self-harm-referral: referral_sent', {
      guardrailId: this.id,
      stage,
      country: place.country,
      method: verdict.method,
      judgeOutcome: verdict.outcome,
    });
    this.emit(event);
    // A host that reads verdicts instead of events gets every field the event carries, the turn's ids and time included.
    const { type, ...fields } = event;
    return {
      action: GuardrailAction.BLOCK,
      reason: referral.text,
      reasonCode: REFERRAL_REASON_CODE,
      replacementText: referral.text,
      metadata: {
        ...fields,
        lineIds: [...lineIds],
        event: type,
        phraseListVersion: SELF_HARM_PHRASES_VERSION,
      },
    };
  }

  /**
   * `private` mode: a keyword match goes to the judge. Confirmed at or above the threshold: a FLAG carrying the
   * private reply for the speaker, and the event. Cleared: null. Unsure, failed or timed out, or no person to send it
   * to: no referral, and a FLAG a host puts before a person. Never a BLOCK and never a hold: the message itself is
   * decided by the host's other guards.
   */
  private async evaluatePrivately(text: string, context: GuardrailContext | undefined, hints: PlaceHint[]): Promise<GuardrailEvaluationResult | null> {
    const matched = phraseMatches(this.inputPhrases, text);
    if (matched.length === 0) return null;
    const verdict = await this.ask(text, matched, context, 'input');
    if (!verdict.refer) return null;
    if (verdict.outcome !== 'confirmed') return this.unconfirmed(verdict.outcome);
    const recipientId = recipientOf(context);
    // Confirmed, but nobody can be named to send it to: nothing is sent, and a person reads the item
    if (recipientId === undefined) return this.unconfirmed('confirmed');
    return this.referPrivately(context, hints, verdict, recipientId);
  }

  /** The verdict of a match that sent no referral, and its one line. */
  private unconfirmed(judgeOutcome: JudgeOutcome): GuardrailEvaluationResult {
    this.log('info', 'self-harm-referral: unconfirmed match; no referral sent', { guardrailId: this.id, stage: 'input', judgeOutcome });
    return {
      action: GuardrailAction.FLAG,
      reasonCode: UNCONFIRMED_REASON_CODE,
      metadata: { guardrailId: this.id, stage: 'input', judgeOutcome, phraseListVersion: SELF_HARM_PHRASES_VERSION },
    };
  }

  /** Builds the private referral for the turn's place, counts it, logs it, reports it, and returns the FLAG that carries it. */
  private referPrivately(context: GuardrailContext | undefined, hints: PlaceHint[], verdict: JudgeResult, recipientId: string): GuardrailEvaluationResult {
    const place: ReferralPlace = resolvePlace(this.table, hints);
    const sessionId = context?.sessionId;
    const conversationId = context?.conversationId;
    const referral = privateReferralFor(this.table, place, {
      recipientId,
      guardrailId: this.id,
      method: verdict.method,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      conversationId: typeof conversationId === 'string' && conversationId ? conversationId : null,
      occurredAt: new Date(this.now()).toISOString(),
    });
    this.sent += 1;
    // One line per referral, with no words of the person's
    this.log('info', 'self-harm-referral: referral_sent', {
      guardrailId: this.id, stage: 'input', country: place.country, method: verdict.method, judgeOutcome: verdict.outcome, delivery: 'private',
    });
    this.emit(referral.event);
    const { type, ...fields } = referral.event;
    return {
      action: GuardrailAction.FLAG,
      reasonCode: REFERRAL_REASON_CODE,
      metadata: {
        ...fields,
        lineIds: [...referral.lineIds],
        event: type,
        phraseListVersion: SELF_HARM_PHRASES_VERSION,
        privateReply: { recipientId, text: referral.text, lineIds: [...referral.lineIds] },
      },
    };
  }
}
