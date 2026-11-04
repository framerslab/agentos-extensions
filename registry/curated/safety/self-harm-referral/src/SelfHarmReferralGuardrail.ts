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
  readonly id: string;
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
  async evaluateInput(_payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    return null;
  }

  /** Replaces an agent's final reply that carries the topic on with the referral. */
  async evaluateOutput(_payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    return null;
  }

  private defaultPlace(): PlaceHint[] {
    return [{ country: this.options.country }, { locale: this.options.locale }];
  }

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the judge took longer than ${this.judgeTimeoutMs} ms`)), this.judgeTimeoutMs);
      });
      const verdict = await Promise.race([this.judge.judge(text, matched, judgeContext), deadline]);
      const usable =
        verdict && typeof verdict.block === 'boolean' && typeof verdict.confidence === 'number' && Number.isFinite(verdict.confidence);
      if (!usable) {
        this.logger.warn('self-harm-referral: judge gave no usable answer; the referral stands', { guardrailId: this.id, stage });
        return { refer: true, method: 'keyword_and_judge', outcome: 'failed' };
      }
      if (verdict.block) return { refer: true, method: 'keyword_and_judge', outcome: 'confirmed' };
      if (verdict.confidence < this.judgeThreshold) return { refer: true, method: 'keyword_and_judge', outcome: 'unsure' };
      return { refer: false, method: 'keyword_and_judge', outcome: 'none' };
    } catch (error) {
      this.logger.warn('self-harm-referral: judge failed; the referral stands', {
        guardrailId: this.id,
        stage,
        error: error instanceof Error ? error.message : String(error),
      });
      return { refer: true, method: 'keyword_and_judge', outcome: 'failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async refer(
    stage: ReferralStage,
    context: GuardrailContext | undefined,
    hints: PlaceHint[],
    verdict: JudgeResult,
  ): Promise<GuardrailEvaluationResult> {
    const place = resolvePlace(this.table, hints);
    const referral = buildReferral(this.table, place.country);
    const lineIds = referral.lines.map((line) => line.id);
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
      sessionId: typeof context?.sessionId === 'string' && context.sessionId ? context.sessionId : null,
      conversationId: typeof context?.conversationId === 'string' && context.conversationId ? context.conversationId : null,
      occurredAt: new Date(this.now()).toISOString(),
    };
    this.sent += 1;
    // One line per referral, with no words of the person's or the agent's.
    this.logger.info('self-harm-referral: referral_sent', {
      guardrailId: this.id,
      stage,
      country: place.country,
      method: verdict.method,
      judgeOutcome: verdict.outcome,
    });
    if (this.options.onEvent) {
      try {
        await this.options.onEvent(event);
      } catch (error) {
        this.logger.warn('self-harm-referral: the host event handler threw; the referral is sent', {
          guardrailId: this.id,
          stage,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      action: GuardrailAction.BLOCK,
      reason: referral.text,
      reasonCode: REFERRAL_REASON_CODE,
      replacementText: referral.text,
      metadata: {
        guardrailId: this.id,
        event: 'referral_sent',
        stage,
        country: place.country,
        locale: place.locale,
        lineIds,
        method: verdict.method,
        judgeOutcome: verdict.outcome,
        tableVersion: this.table.version,
        phraseListVersion: SELF_HARM_PHRASES_VERSION,
      },
    };
  }
}
