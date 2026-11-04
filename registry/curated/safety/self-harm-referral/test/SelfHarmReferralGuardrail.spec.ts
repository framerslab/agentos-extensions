/**
 * @fileoverview The self-harm referral guard through AgentOS's own guardrail dispatchers: a person's message that
 * calls for a referral is answered with it and the host hears of it, an ordinary message passes, and an agent's reply
 * that carries the topic on is replaced by it before any of its text reaches the person.
 *
 * Every number the assertions read comes from the shipped table (`REFERRAL_TABLE`), never typed here.
 */
import { AgentOSResponseChunkType, type AgentOSInput, type AgentOSResponse } from '@framers/agentos';
import {
  GuardrailAction,
  createGuardrailBlockedStream,
  evaluateInputGuardrails,
  wrapOutputGuardrails,
  type GuardrailContext,
  type PhraseJudge,
  type PhraseJudgeVerdict,
} from '@framers/agentos/safety/guardrails';
import { describe, expect, it, vi } from 'vitest';

import {
  REFERRAL_REASON_CODE,
  REFERRAL_TABLE,
  SelfHarmReferralGuardrail,
  createExtensionPack,
  type ReferralLine,
  type ReferralSentEvent,
  type SelfHarmReferralOptions,
} from '../src/index.js';

const at = '2026-11-04T12:00:00.000Z';

function context(metadata?: Record<string, unknown>): GuardrailContext {
  return { userId: 'user-1', sessionId: 'session-1', conversationId: 'conversation-1', ...(metadata ? { metadata } : {}) };
}

function message(textInput: string, extra: Partial<AgentOSInput> = {}): AgentOSInput {
  return { userId: 'user-1', sessionId: 'session-1', conversationId: 'conversation-1', textInput, ...extra };
}

/** The guard as a host receives it from the pack, with its events kept. */
function build(options: SelfHarmReferralOptions = {}) {
  const events: ReferralSentEvent[] = [];
  const pack = createExtensionPack({
    options: { now: () => Date.parse(at), onEvent: (event: ReferralSentEvent) => void events.push(event), ...options },
  });
  const descriptor = pack.descriptors[0];
  return { pack, descriptor, guard: descriptor.payload as SelfHarmReferralGuardrail, events };
}

/** A model turn that streams `text` and ends with it as the final reply. */
async function* reply(text: string): AsyncGenerator<AgentOSResponse, void, undefined> {
  const base = { streamId: 'stream-1', gmiInstanceId: 'gmi-1', personaId: 'persona-1', timestamp: at };
  yield { ...base, type: AgentOSResponseChunkType.TEXT_DELTA, isFinal: false, textDelta: text } as AgentOSResponse;
  yield { ...base, type: AgentOSResponseChunkType.FINAL_RESPONSE, isFinal: true, finalResponseText: text } as AgentOSResponse;
}

async function collect(stream: AsyncGenerator<AgentOSResponse, void, undefined>): Promise<AgentOSResponse[]> {
  const chunks: AgentOSResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** The lines the shipped table gives a referral for `country` (null: no known country), in the order it names them. */
function linesFor(country: string | null): ReferralLine[] {
  const own = country ? REFERRAL_TABLE.countries[country].lines : [];
  const always = REFERRAL_TABLE.countries[REFERRAL_TABLE.always].lines;
  const lines = [...own, ...always, REFERRAL_TABLE.elsewhere];
  return lines.filter((line, index) => lines.findIndex((other) => other.id === line.id) === index);
}

/** The sentence a referral for `country` closes with. */
function closingFor(country: string | null): string {
  const emergency = country ? REFERRAL_TABLE.countries[country].emergency : undefined;
  return emergency ? REFERRAL_TABLE.emergency.known.replace('{number}', emergency.number) : REFERRAL_TABLE.emergency.unknown;
}

function expectReferralFor(text: string | null | undefined, country: string | null): void {
  expect(text).toBeTypeOf('string');
  expect(text).toContain(REFERRAL_TABLE.intro);
  for (const line of linesFor(country)) expect(text).toContain(`${line.label}: ${line.text}`);
  expect(text).toContain(closingFor(country));
}

const clearing: PhraseJudge = { judge: async () => ({ block: false, confidence: 0.95, reason: 'figurative' }) };

describe('a person writes something that calls for a referral', () => {
  it('is answered with the referral in place of the agent, and the host hears of it once, with none of their words', async () => {
    const { guard, events } = build();
    const said = 'I want to kill myself tonight';

    const outcome = await evaluateInputGuardrails([guard], message(said), context());

    expect(outcome.evaluation?.action).toBe(GuardrailAction.BLOCK);
    expect(outcome.evaluation?.reasonCode).toBe(REFERRAL_REASON_CODE);
    expect(outcome.evaluation?.replacementText).toBe(outcome.evaluation?.reason);
    // What AgentOS sends the person for a blocked message: one final chunk carrying the guard's reason, no model turn.
    const sent = await collect(createGuardrailBlockedStream(context(), outcome.evaluation!, { streamId: 'stream-1' }));
    expect(sent).toHaveLength(1);
    expect(sent[0].isFinal).toBe(true);
    // An ERROR-type chunk under the guard's code, so a host that hides error chunks would hide the lines (the README says so).
    expect(sent[0].type).toBe(AgentOSResponseChunkType.ERROR);
    expect((sent[0] as { code?: string }).code).toBe(REFERRAL_REASON_CODE);
    expectReferralFor((sent[0] as { message?: string }).message, null);

    expect(events).toEqual([
      {
        type: 'referral_sent',
        guardrailId: 'self-harm-referral',
        stage: 'input',
        country: null,
        locale: null,
        lineIds: linesFor(null).map((line) => line.id),
        method: 'keyword',
        judgeOutcome: 'none',
        tableVersion: REFERRAL_TABLE.version,
        sessionId: 'session-1',
        conversationId: 'conversation-1',
        occurredAt: at,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(said);
    expect(guard.referralsSent).toBe(1);
  });

  it('is found through look-alike letters, invisible characters and case', async () => {
    const { guard, events } = build();

    // A Cyrillic "і" in place of the Latin i, a zero-width space inside the phrase, and capitals.
    const outcome = await evaluateInputGuardrails([guard], message('I just WANT TO DіE, honestly​'), context());
    const second = await evaluateInputGuardrails([guard], message('thinking about ending my​ life'), context());

    expect(outcome.evaluation?.action).toBe(GuardrailAction.BLOCK);
    expect(second.evaluation?.action).toBe(GuardrailAction.BLOCK);
    expect(events).toHaveLength(2);
  });

  it('is found in the contracted forms people type: wanna, gonna, dont wanna', async () => {
    const { guard, events } = build();
    const said = ['I wanna die', "I don't wanna live anymore", 'i dont wanna be alive', "I'm gonna die", 'I didn’t wanna wake up'];

    for (const text of said) {
      const outcome = await evaluateInputGuardrails([guard], message(text), context());
      expect(outcome.evaluation?.action, text).toBe(GuardrailAction.BLOCK);
    }
    expect(events).toHaveLength(said.length);
  });

  it('is found in the words of suicide screening questions, in slang and in common misspellings', async () => {
    const { guard, events } = build();
    const said = [
      'I wished I was dead',
      'I wished I had never been born',
      'I want to be dead',
      'life is not worth living',
      "my life isn't worth living",
      'there is no point in living',
      'I just want to go to sleep and never wake up',
      "I hope I don't wake up tomorrow",
      'i might kms',
      "I'm gonna kms",
      'I feel sucidal',
      'thinking about suiside',
    ];

    for (const text of said) {
      const outcome = await evaluateInputGuardrails([guard], message(text), context());
      expect(outcome.evaluation?.action, text).toBe(GuardrailAction.BLOCK);
    }
    expect(events).toHaveLength(said.length);
  });

  it("leads with the line of the turn's country: its country field, then its locale, then the pack's default", async () => {
    const { guard, events } = build({ country: 'IE' });

    const byCountry = await evaluateInputGuardrails([guard], message('I keep thinking about suicide'), context({ country: 'AU', locale: 'en-GB' }));
    const byLocale = await evaluateInputGuardrails([guard], message('I keep thinking about suicide'), context({ locale: 'en_gb' }));
    const byHint = await evaluateInputGuardrails([guard], message('I keep thinking about suicide', { languageHint: 'en-NZ' }), context());
    const byDefault = await evaluateInputGuardrails([guard], message('I keep thinking about suicide'), context({ locale: 'de' }));

    expectReferralFor(byCountry.evaluation?.replacementText, 'AU');
    expectReferralFor(byLocale.evaluation?.replacementText, 'GB');
    expectReferralFor(byHint.evaluation?.replacementText, 'NZ');
    expectReferralFor(byDefault.evaluation?.replacementText, 'IE');
    expect(events.map(({ country, locale }) => ({ country, locale }))).toEqual([
      { country: 'AU', locale: null },
      { country: 'GB', locale: 'en_gb' },
      { country: 'NZ', locale: 'en-NZ' },
      { country: 'IE', locale: null },
    ]);
  });

  it("names the default lines and no other country's emergency number when the turn names no country the table holds", async () => {
    const { guard } = build();

    const outcome = await evaluateInputGuardrails([guard], message('I want to die'), context({ country: 'DE', locale: 'es-419' }));

    expectReferralFor(outcome.evaluation?.replacementText, null);
    for (const country of Object.values(REFERRAL_TABLE.countries)) {
      if (country.emergency) expect(outcome.evaluation?.replacementText).not.toContain(REFERRAL_TABLE.emergency.known.replace('{number}', country.emergency.number));
    }
  });
});

describe('the judge', () => {
  it('clears a figurative match, which then passes, and is asked only about a text the list matched', async () => {
    const judge = { judge: vi.fn(clearing.judge) };
    const { guard, events } = build({ judge });

    const figurative = await evaluateInputGuardrails([guard], message('That video, I could kill myself laughing'), context());
    const ordinary = await evaluateInputGuardrails([guard], message('Can you plan a birthday dinner for six?'), context());

    expect(figurative.evaluation).toBeUndefined();
    expect(ordinary.evaluation).toBeUndefined();
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(judge.judge.mock.calls[0][0]).toBe('That video, I could kill myself laughing');
    expect(judge.judge.mock.calls[0][1].length).toBeGreaterThan(0);
    expect(events).toEqual([]);
  });

  it('leaves the referral standing when it confirms, throws, answers nothing usable, is unsure or is too slow', async () => {
    const answers: Array<() => Promise<PhraseJudgeVerdict>> = [
      async () => ({ block: true, confidence: 0.9 }),
      async () => {
        throw new Error('provider down');
      },
      async () => ({}) as PhraseJudgeVerdict,
      async () => ({ block: false, confidence: 0.4 }),
      () => new Promise<PhraseJudgeVerdict>(() => {}),
    ];
    let next = 0;
    const warnings: string[] = [];
    const logger = { info() {}, error() {}, warn: (line: string) => void warnings.push(line) };
    const { guard, events } = build({ judge: { judge: () => answers[next++]() }, judgeTimeoutMs: 50, logger });

    for (let i = 0; i < answers.length; i += 1) {
      const outcome = await evaluateInputGuardrails([guard], message('I want to end my life'), context());
      expect(outcome.evaluation?.action).toBe(GuardrailAction.BLOCK);
    }

    expect(events.map((event) => [event.method, event.judgeOutcome])).toEqual([
      ['keyword_and_judge', 'confirmed'],
      ['keyword_and_judge', 'failed'],
      ['keyword_and_judge', 'failed'],
      ['keyword_and_judge', 'unsure'],
      ['keyword_and_judge', 'failed'],
    ]);
    expect(warnings).toHaveLength(3);
  });
});

describe('the host', () => {
  it("reads on the verdict every field the event carries, the turn's ids and the time included", async () => {
    const { guard, events } = build();

    const outcome = await evaluateInputGuardrails([guard], message('I want to die'), context({ locale: 'en-GB' }));

    expect(events).toHaveLength(1);
    const { type, ...fields } = events[0];
    expect(outcome.evaluation?.metadata).toMatchObject({ event: type, ...fields });
    expect(outcome.evaluation?.metadata).toMatchObject({ sessionId: 'session-1', conversationId: 'conversation-1', occurredAt: at });
  });

  it("gets the referral sent though its event handler never settles or its logger throws", async () => {
    const throwing = {
      info() {
        throw new Error('log sink down');
      },
      warn() {
        throw new Error('log sink down');
      },
      error() {
        throw new Error('log sink down');
      },
    };
    const stalled = createExtensionPack({ options: { onEvent: () => new Promise<void>(() => {}) } });
    const unlogged = createExtensionPack({
      options: {
        logger: throwing,
        judge: {
          judge: async () => {
            throw new Error('provider down');
          },
        },
      },
    });

    const outcomes = await Promise.all(
      [stalled, unlogged].map((pack) =>
        (pack.descriptors[0].payload as SelfHarmReferralGuardrail).evaluateInput({ input: message('I want to die'), context: context() }),
      ),
    );

    for (const outcome of outcomes) expectReferralFor(outcome?.replacementText, null);
  }, 5_000);

  it("logs no word of the person's even when the judge's error repeats them", async () => {
    const said = 'I want to end my life tonight';
    const lines: unknown[] = [];
    const keep = (line: string, meta?: Record<string, unknown>) => void lines.push([line, meta]);
    const { guard } = build({
      logger: { info: keep, warn: keep, error: keep },
      judge: {
        judge: async (text) => {
          throw new Error(`provider refused the request: ${text}`);
        },
      },
    });

    const outcome = await evaluateInputGuardrails([guard], message(said), context());

    expect(outcome.evaluation?.action).toBe(GuardrailAction.BLOCK);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain('end my life');
  });
});

describe('an ordinary message', () => {
  it('passes with no verdict and no event', async () => {
    const { guard, events } = build();

    const outcome = await evaluateInputGuardrails([guard], message('What is a good recipe for a quick weeknight curry?'), context());

    expect(outcome.evaluation).toBeUndefined();
    expect(outcome.sanitizedInput.textInput).toBe('What is a good recipe for a quick weeknight curry?');
    expect(events).toEqual([]);
    expect(guard.referralsSent).toBe(0);
  });

  it('passes when it only comes near a listed phrase', async () => {
    const { guard, events } = build();
    const said = [
      'We drove 200 kms to the coast',
      'That was a lucid dream',
      'The queue was not worth the wait',
      'I hope I wake up on time',
      'My alarm failed and I did not wake up',
    ];

    for (const text of said) {
      const outcome = await evaluateInputGuardrails([guard], message(text), context());
      expect(outcome.evaluation, text).toBeUndefined();
    }
    expect(events).toEqual([]);
  });
});

describe("an agent's reply", () => {
  it('that carries the topic on is replaced by the referral, and none of its text reaches the person', async () => {
    const { guard, events } = build();
    const carriesOn = "I hear that you want to die. Let's talk through why you want to end your life.";

    const sent = await collect(
      wrapOutputGuardrails([guard], context({ locale: 'en-GB' }), reply(carriesOn), { streamId: 'stream-1', holdUntilFinal: true }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    const finalText = (sent[0] as { finalResponseText?: string }).finalResponseText;
    expectReferralFor(finalText, 'GB');
    expect(JSON.stringify(sent)).not.toContain(carriesOn);
    expect(events).toEqual([
      expect.objectContaining({
        stage: 'output',
        country: 'GB',
        locale: 'en-GB',
        lineIds: linesFor('GB').map((line) => line.id),
        method: 'keyword',
      }),
    ]);
  });

  it('that does not carry the topic on passes unchanged', async () => {
    const { guard, events } = build();
    const ordinary = 'Here is a quick curry: onions, garlic, ginger, tomatoes and chickpeas.';

    const sent = await collect(wrapOutputGuardrails([guard], context(), reply(ordinary), { streamId: 'stream-1', holdUntilFinal: true }));

    expect(sent.map((chunk) => chunk.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.FINAL_RESPONSE]);
    expect((sent[1] as { finalResponseText?: string }).finalResponseText).toBe(ordinary);
    expect(events).toEqual([]);
  });
});

describe('the pack', () => {
  it('gives a host that calls its factory with no context a guardrail that refers on the keyword list', async () => {
    const pack = createExtensionPack();
    const descriptor = pack.descriptors[0];

    expect(pack.name).toBe('@framers/agentos-ext-self-harm-referral');
    expect(descriptor.kind).toBe('guardrail');
    expect(descriptor.id).toBe('self-harm-referral');
    const outcome = await (descriptor.payload as SelfHarmReferralGuardrail).evaluateInput({
      input: message('i want to kill myself'),
      context: context(),
    });
    expect(outcome?.action).toBe(GuardrailAction.BLOCK);
  });

  it('ships a table that names the page stating every number it gives', () => {
    const urls: string[] = [REFERRAL_TABLE.elsewhere.source];
    expect(REFERRAL_TABLE.countries[REFERRAL_TABLE.always]).toBeDefined();
    for (const [code, country] of Object.entries(REFERRAL_TABLE.countries)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(country.lines.length).toBeGreaterThan(0);
      for (const line of country.lines) {
        expect(line.id && line.label && line.text).toBeTruthy();
        urls.push(line.source);
      }
      if (country.emergency) urls.push(country.emergency.source);
    }
    for (const url of urls) expect(new URL(url).protocol).toBe('https:');
  });
});
