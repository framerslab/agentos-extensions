/**
 * @file privateDelivery.integration.spec.ts
 * The self-harm referral guard in `private` mode through AgentOS's moderateContent(): in a room, a keyword match the
 * judge confirms is answered with a private referral for the speaker alone, as a flag and never a block; a judge that
 * is unsure, fails or never answers sends nothing and flags the item for a person; a cleared match passes. And
 * createPrivateReferral() builds the same referral for a message another classifier confirmed.
 */
import { moderateContent, type GuardrailContext } from '@framers/agentos';
import { GuardrailAction, type PhraseJudge, type PhraseJudgeVerdict } from '@framers/agentos/safety/guardrails';
import { describe, expect, it, vi } from 'vitest';

import {
  REFERRAL_REASON_CODE,
  REFERRAL_TABLE,
  SelfHarmReferralGuardrail,
  UNCONFIRMED_REASON_CODE,
  createPrivateReferral,
  type ReferralSentEvent,
} from '../src/index.js';

const at = '2026-11-10T12:00:00.000Z';
const now = (): number => Date.parse(at);
/** A room message's context: the speaker is the sender; the call runs for the room's moderation account. */
const room = (metadata?: Record<string, unknown>): GuardrailContext => ({
  userId: 'moderation-account',
  sessionId: 'session-1',
  conversationId: 'room-r1',
  moderation: { surface: 'public_room', roomId: 'r1', rating: 'standard', messageId: 'm1', sender: { id: 'u-speaker', kind: 'account' } },
  ...(metadata ? { metadata } : {}),
});
const confirming: PhraseJudge = { judge: async () => ({ block: true, confidence: 0.9, reason: 'the writer says so' }) };
const clearing: PhraseJudge = { judge: async () => ({ block: false, confidence: 0.95, reason: 'a game' }) };
const never: PhraseJudge = { judge: () => new Promise<PhraseJudgeVerdict>(() => {}) };

function build(judge: PhraseJudge) {
  const events: ReferralSentEvent[] = [];
  const guard = new SelfHarmReferralGuardrail({ delivery: 'private', judge, judgeTimeoutMs: 50, now, onEvent: (event) => void events.push(event) });
  return { guard, events };
}
type PrivateReply = { recipientId: string; text: string; lineIds: string[] };
const ofGuard = (decision: Awaited<ReturnType<typeof moderateContent>>) =>
  decision.evaluations.find((evaluation) => (evaluation.metadata as { guardrailId?: unknown } | undefined)?.guardrailId === 'self-harm-referral');
const replyOf = (decision: Awaited<ReturnType<typeof moderateContent>>): PrivateReply | undefined =>
  (ofGuard(decision)?.metadata as { privateReply?: PrivateReply } | undefined)?.privateReply;

describe('private delivery in a room', () => {
  it('(a) a match the judge confirms is a flag carrying the private reply for the speaker, never a block', async () => {
    const { guard, events } = build(confirming);
    const decision = await moderateContent({ text: 'i want to die' }, { guards: [guard], context: room({ country: 'GB' }) });

    expect(decision).toMatchObject({ outcome: 'flag', unavailable: false });
    expect(ofGuard(decision)?.action).toBe(GuardrailAction.FLAG);
    expect(ofGuard(decision)?.reasonCode).toBe(REFERRAL_REASON_CODE);
    const reply = replyOf(decision);
    expect(reply?.recipientId).toBe('u-speaker');
    expect(reply?.lineIds[0]).toBe(REFERRAL_TABLE.countries.GB.lines[0].id);
    expect(reply?.text.startsWith(REFERRAL_TABLE.intro)).toBe(true);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'referral_sent', stage: 'input', country: 'GB', delivery: 'private', recipientId: 'u-speaker',
      method: 'keyword_and_judge', judgeOutcome: 'confirmed', occurredAt: at,
    });
    expect(JSON.stringify(events)).not.toContain('i want to die');

    // the same referral, built for a message another classifier confirmed
    const built = createPrivateReferral({ recipientId: 'u-speaker', country: 'GB', now });
    expect(built.text).toBe(reply?.text);
    expect(built.lineIds).toEqual(reply?.lineIds);
    expect(built.event).toMatchObject({ method: 'classifier', judgeOutcome: 'confirmed', stage: 'input', delivery: 'private', recipientId: 'u-speaker', occurredAt: at });
  });

  it('(a) with no sender in the context, the referral is for the user the call runs for', async () => {
    const { guard } = build(confirming);
    const decision = await moderateContent({ text: 'i want to die' }, { guards: [guard], context: { userId: 'u-writer', sessionId: 'session-1' } });
    expect(replyOf(decision)?.recipientId).toBe('u-writer');
  });

  it('(b) a judge that never answers sends nothing and flags the item for a person', async () => {
    const { guard, events } = build(never);
    const decision = await moderateContent({ text: 'i want to die' }, { guards: [guard], context: room() });
    expect(decision).toMatchObject({ outcome: 'flag', unavailable: false });
    expect(ofGuard(decision)).toMatchObject({ action: GuardrailAction.FLAG, reasonCode: UNCONFIRMED_REASON_CODE, metadata: { judgeOutcome: 'failed' } });
    expect(replyOf(decision)).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('(b) an unsure judge and a judge that throws send nothing either', async () => {
    const cases: Array<[PhraseJudge, string]> = [
      [{ judge: async () => ({ block: false, confidence: 0.4, reason: 'unclear' }) }, 'unsure'],
      [{ judge: async () => { throw new Error('the vendor is down'); } }, 'failed'],
    ];
    for (const [judge, outcome] of cases) {
      const { guard, events } = build(judge);
      const decision = await moderateContent({ text: 'i want to die' }, { guards: [guard], context: room() });
      expect(decision).toMatchObject({ outcome: 'flag', unavailable: false });
      expect(ofGuard(decision)).toMatchObject({ reasonCode: UNCONFIRMED_REASON_CODE, metadata: { judgeOutcome: outcome } });
      expect(replyOf(decision)).toBeUndefined();
      expect(events).toEqual([]);
    }
  });

  it('(c) a match the judge clears passes', async () => {
    const judge = { judge: vi.fn(clearing.judge) };
    const { guard, events } = build(judge);
    const decision = await moderateContent({ text: 'how do I die in this level' }, { guards: [guard], context: room() });
    expect(decision).toMatchObject({ outcome: 'allow' });
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it('(d) private delivery with no judge, or with an output stage, does not build', () => {
    expect(() => new SelfHarmReferralGuardrail({ delivery: 'private' })).toThrow(/judge/);
    expect(() => new SelfHarmReferralGuardrail({ delivery: 'private', judge: confirming, stages: ['input', 'output'] })).toThrow(/output/);
  });

  it('flags a confirmed match without a recipient, without reporting a referral', async () => {
    const { guard, events } = build(confirming);
    const decision = await moderateContent({ text: 'i want to die' }, {
      guards: [guard], context: { userId: '', sessionId: 'session-1' },
    });
    expect(decision).toMatchObject({ outcome: 'flag', unavailable: false });
    expect(ofGuard(decision)).toMatchObject({ reasonCode: UNCONFIRMED_REASON_CODE, metadata: { judgeOutcome: 'confirmed' } });
    expect(replyOf(decision)).toBeUndefined();
    expect(events).toEqual([]);
    expect(guard.referralsSent).toBe(0);
  });

  it('keeps judge and callback error names out of private delivery logs', async () => {
    for (const failing of ['judge', 'callback']) {
      const lines: unknown[] = [];
      const keep = (message: string, metadata?: Record<string, unknown>) => void lines.push([message, metadata]);
      const fail = () => { throw Object.assign(new Error('ZZMARK_QX'), { name: 'ZzmarkQxError' }); };
      const guard = new SelfHarmReferralGuardrail({
        delivery: 'private', judge: failing === 'judge' ? { judge: async () => fail() } : confirming,
        onEvent: failing === 'callback' ? fail : undefined,
        logger: { info: keep, warn: keep, error: keep },
      });
      const decision = await moderateContent({ text: 'i want to die' }, { guards: [guard], context: room() });
      expect(lines.length).toBeGreaterThan(0);
      expect(JSON.stringify(lines).toLowerCase()).not.toContain('zzmark');
      expect(decision).toMatchObject({ outcome: 'flag', unavailable: false });
      expect(Boolean(replyOf(decision))).toBe(failing === 'callback');
    }
  });

  it('runs open, on input alone, and lists its codes', () => {
    const { guard } = build(confirming);
    expect(guard.stages).toEqual(['input']);
    expect(guard.config).toMatchObject({ canSanitize: false, evaluateStreamingChunks: false, failClosed: false });
    expect(guard.config.reasonCodes).toEqual(expect.arrayContaining([REFERRAL_REASON_CODE, UNCONFIRMED_REASON_CODE]));
  });
});
