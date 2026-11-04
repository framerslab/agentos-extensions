/**
 * @fileoverview The self-harm referral guard: an input and output guardrail that answers a self-harm expression with
 * crisis lines and reports each referral to its host.
 *
 * On a person's message (input) or an agent's final reply (output) it matches the reviewed keyword list over the
 * normalised text; a match goes to the judge when one is configured, and a match the judge does not clear is answered
 * with the referral: a BLOCK whose `replacementText` (and `reason`) is the referral's text, so the topic does not go
 * on, and a `referral_sent` event for the host to count. The guard fails toward the referral: a judge that throws,
 * times out, answers nothing usable or clears a match with too little confidence leaves the referral standing.
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
import { REFERRAL_TABLE, buildReferral, resolvePlace, type PlaceHint } from './referrals.js';
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

/** The judge's confidence at or above which its clearing of a match counts, when the host sets none. */
export const DEFAULT_JUDGE_THRESHOLD = 0.7;

/** How long the judge may take, when the host sets no limit. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 6_000;

/**
 * What the model judge is asked to decide about a keyword match. The judge blocks (`block: true`) when the text calls
 * for a crisis referral, and clears figurative, title and factual uses.
 */
export const SELF_HARM_JUDGE_CRITERIA = [
  'The text calls for a crisis referral when, read in context, it is about suicide or self-harm in one of these ways:',
  '- the writer says they think about, plan, intend or want to end their life, die, or hurt or injure themselves;',
  '- the writer asks for methods, means, places, amounts or ways to do so;',
  "- an assistant's reply describes, encourages or gives information about ways to die or to hurt oneself, or carries on a conversation about the reader's own thoughts of suicide or self-harm.",
  'It does not when the words are figurative or idiomatic ("I could kill myself laughing", "I cut myself shaving"),',
  'name a film, book, song or game, or mention suicide or self-harm as a fact, in history, news, research or fiction,',
  "with nothing about the writer's or the reader's own risk.",
  'Answer block: true when the text calls for a crisis referral, block: false when it does not.',
].join('\n');

/** The final reply chunk's type string in AgentOS (`AgentOSResponseChunkType.FINAL_RESPONSE`). */
const FINAL_RESPONSE = 'final_response';

/** A logger that writes nothing, for a guard built with none. */
const SILENT: ILogger = { info() {}, warn() {}, error() {} };

/** What the judge decided about a match, and whether the referral stands. */
interface JudgeResult {
  refer: boolean;
  method: DetectionMethod;
  outcome: JudgeOutcome;
}

/**
 * The guard. Build it with {@link SelfHarmReferralOptions}; register it before other blocking guards, since AgentOS
 * answers an input with the first BLOCK in registration order.
 */
export class SelfHarmReferralGuardrail implements IGuardrailService {
  /** The guard's id, on its descriptor and its verdicts. */
  readonly id: string;
  /** The stages it evaluates. */
  readonly stages: ReadonlyArray<ReferralStage>;
  /**
   * Final replies only, judged in AgentOS's second phase (it never sanitizes). `failClosed` turns an unexpected throw
   * into a block; the guard's own judge deadline keeps a slow judge from reaching it.
   */
  readonly config: GuardrailConfig = {
    canSanitize: false,
    evaluateStreamingChunks: false,
    failClosed: true,
  };

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
   * on a person's message.
   */
  constructor(private readonly options: SelfHarmReferralOptions = {}) {
    this.id = options.id ?? DEFAULT_GUARDRAIL_ID;
    this.stages = [...(options.stages ?? ['input', 'output'])];
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
            timeoutMs: options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
          })
        : undefined);
    this.judgeThreshold = options.judgeThreshold ?? DEFAULT_JUDGE_THRESHOLD;
    this.judgeTimeoutMs = options.judgeTimeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
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

  /** Answers a person's message that calls for a referral with the referral, in place of the agent's turn. */
  async evaluateInput(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    if (!this.stages.includes('input')) return null;
    const text = payload?.input?.textInput;
    if (typeof text !== 'string' || !text.trim()) return null;
    const context = payload.context;
    return this.evaluate('input', text, this.inputPhrases, context, [
      { country: context?.metadata?.country },
      { locale: context?.metadata?.locale },
      { locale: payload.input.languageHint },
      ...this.defaultPlace(),
    ]);
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
    const failed = (error: unknown) =>
      this.log('warn', 'self-harm-referral: the host event handler failed; the referral is sent', {
        guardrailId: this.id,
        stage: event.stage,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    try {
      const pending = onEvent(event);
      if (pending && typeof (pending as PromiseLike<void>).then === 'function') {
        (pending as PromiseLike<void>).then(undefined, failed);
      }
    } catch (error) {
      failed(error);
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
    try {
      const deadline = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), this.judgeTimeoutMs);
      });
      const verdict = await Promise.race([this.judge.judge(text, matched, judgeContext), deadline]);
      if (verdict === timedOut) {
        this.log('warn', 'self-harm-referral: judge timed out; the referral stands', { guardrailId: this.id, stage, timeoutMs: this.judgeTimeoutMs });
        return { refer: true, method: 'keyword_and_judge', outcome: 'failed' };
      }
      const usable =
        verdict && typeof verdict.block === 'boolean' && typeof verdict.confidence === 'number' && Number.isFinite(verdict.confidence);
      if (!usable) {
        this.log('warn', 'self-harm-referral: judge gave no usable answer; the referral stands', { guardrailId: this.id, stage });
        return { refer: true, method: 'keyword_and_judge', outcome: 'failed' };
      }
      if (verdict.block) return { refer: true, method: 'keyword_and_judge', outcome: 'confirmed' };
      if (verdict.confidence < this.judgeThreshold) return { refer: true, method: 'keyword_and_judge', outcome: 'unsure' };
      return { refer: false, method: 'keyword_and_judge', outcome: 'none' };
    } catch (error) {
      // The error's name only: a judge's or a provider's message can repeat the text it was given.
      this.log('warn', 'self-harm-referral: judge failed; the referral stands', {
        guardrailId: this.id,
        stage,
        errorName: error instanceof Error ? error.name : typeof error,
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
}
