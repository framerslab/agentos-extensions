/**
 * @fileoverview The shapes the self-harm referral guard reads and reports: the table of crisis lines, the options a
 * host builds the guard with, and the event each referral emits.
 *
 * @module @framers/agentos-ext-self-harm-referral/types
 */

import type { ILogger } from '@framers/agentos';
import type { PhraseEntry, PhraseJudge } from '@framers/agentos/safety/guardrails';

/** A crisis line a referral names. */
export interface ReferralLine {
  /** A stable id the referral event reports (`us-988`). */
  id: string;
  /** Where the line answers, the start of its sentence: `In the United States`. */
  label: string;
  /** What to do, the rest of its sentence: `call or text 988, ...`. */
  text: string;
  /** The page that states the number. */
  source: string;
}

/** A country's emergency number and the page that states it. */
export interface EmergencyNumber {
  number: string;
  source: string;
}

/** The lines a referral names for one country, and its emergency number. */
export interface CountryReferral {
  name: string;
  lines: ReferralLine[];
  emergency?: EmergencyNumber;
}

/** The table a referral is built from: `src/referral-lines.json`, or the host's own of the same shape. */
export interface ReferralTable {
  /** The table's version, reported with every referral. */
  version: string;
  /** The day its numbers were last read at their sources. */
  reviewedAt: string;
  /** The opening sentence of every referral. */
  intro: string;
  /** The country (ISO 3166-1 alpha-2) whose lines every referral names, after the turn's own country's. */
  always: string;
  /** The lines by country (ISO 3166-1 alpha-2, upper case). */
  countries: Record<string, CountryReferral>;
  /** The line for every other country, named last. */
  elsewhere: ReferralLine;
  /** The closing sentence: `known` with the country's number in `{number}`, `unknown` when the table has none. */
  emergency: { known: string; unknown: string };
}

/** The stages the guard evaluates. */
export type ReferralStage = 'input' | 'output';

/** How a referral's text was found to call for one. */
export type DetectionMethod = 'keyword' | 'keyword_and_judge';

/**
 * What the judge said about a keyword match that led to a referral: `none` when no judge is configured, `confirmed`
 * when it found the text calls for one, `unsure` when it cleared the text below the threshold, `failed` when it threw,
 * timed out or answered nothing usable.
 */
export type JudgeOutcome = 'none' | 'confirmed' | 'unsure' | 'failed';

/**
 * The event every referral emits. It names no person and holds none of their words: the host counts it.
 */
export interface ReferralSentEvent {
  type: 'referral_sent';
  /** The guard that sent it. */
  guardrailId: string;
  /** `input` when a person's message called for it, `output` when the guard replaced an agent's reply. */
  stage: ReferralStage;
  /** The country whose lines led the referral, or null when the turn named no country or one the table does not hold. */
  country: string | null;
  /** The locale the country was read from, or null when it came from a country field or from nothing. */
  locale: string | null;
  /** The ids of the lines the referral named, in order. */
  lineIds: string[];
  method: DetectionMethod;
  judgeOutcome: JudgeOutcome;
  /** The version of the table the lines came from. */
  tableVersion: string;
  /** The ids the turn's guardrail context carried, when it carried them. */
  sessionId: string | null;
  conversationId: string | null;
  /** When the referral was sent, as an ISO 8601 time. */
  occurredAt: string;
}

/** The model judge's settings when the guard builds it on AgentOS's `createLlmPhraseJudge`. */
export interface JudgeModelOptions {
  /** The host's provider id (`openai`, `anthropic`, `openrouter`, ...). A provider other than `openai` needs a model. */
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** How a host builds the guard; every field is optional. */
export interface SelfHarmReferralOptions {
  /** The guard's id, on its descriptor and its verdicts. Default `self-harm-referral`. */
  id?: string;
  /** The stages it evaluates. Default both. */
  stages?: ReferralStage[];
  /** A judge the host built, asked about each keyword match. Takes precedence over `judgeModel`. */
  judge?: PhraseJudge;
  /** A model judge on the host's provider, built with AgentOS's `createLlmPhraseJudge`. */
  judgeModel?: JudgeModelOptions;
  /** The judge's confidence at or above which its clearing of a match counts. Default 0.7. */
  judgeThreshold?: number;
  /** How long the judge may take before the referral is sent without its answer. Default 6000 ms. */
  judgeTimeoutMs?: number;
  /** The country (ISO 3166-1 alpha-2) whose lines a referral names when the turn names no country. */
  country?: string;
  /** The locale whose region names the country when the turn names no country. */
  locale?: string;
  /** A table that replaces the one the pack ships. */
  table?: ReferralTable;
  /** Phrases added to the shipped list, on both stages. */
  extraPhrases?: PhraseEntry[];
  /**
   * Called with each referral's event. The guard does not wait on it: a handler that throws, rejects or never settles
   * does not hold the referral back, and a synchronous handler has the event before the verdict returns.
   */
  onEvent?: (event: ReferralSentEvent) => void | Promise<void>;
  /**
   * Where the guard writes one line per referral and per judge failure, the pack's host logger by default. A logger
   * that throws never stops a referral.
   */
  logger?: ILogger;
  /** The clock the event's time is read from. Default `Date.now`. */
  now?: () => number;
}
