// The pack as an application imports it from the installed, published package: private delivery through
// moderateContent(), and createPrivateReferral(). Each block is one real path; the last line prints the count the
// workflow reads. Its judge is its own; no model is called.
import assert from 'node:assert/strict';
import { moderateContent } from '@framers/agentos';
import { SelfHarmReferralGuardrail, createPrivateReferral } from '@framers/agentos-ext-self-harm-referral';

let items = 0;
const room = {
  userId: 'moderation-account', sessionId: 'session-1',
  moderation: { surface: 'public_room', roomId: 'r1', messageId: 'm1', sender: { id: 'u-speaker', kind: 'account' } },
  metadata: { country: 'GB' },
};
const reply = (decision) => decision.evaluations.find((e) => e.metadata?.guardrailId === 'self-harm-referral')?.metadata?.privateReply;

// A confirmed match in a room is a flag that carries the referral for the speaker alone.
{
  const guard = new SelfHarmReferralGuardrail({ delivery: 'private', judge: { judge: async () => ({ block: true, confidence: 0.9 }) } });
  const decision = await moderateContent({ text: 'i want to die' }, { guards: [guard], context: room });
  assert.equal(decision.outcome, 'flag');
  assert.equal(reply(decision)?.recipientId, 'u-speaker');
  assert.deepEqual(createPrivateReferral({ recipientId: 'u-speaker', country: 'GB' }).lineIds, reply(decision)?.lineIds);
  items += 1;
}

// A judge that fails sends nothing.
{
  const guard = new SelfHarmReferralGuardrail({ delivery: 'private', judge: { judge: async () => { throw new Error('down'); } } });
  const decision = await moderateContent({ text: 'i want to die' }, { guards: [guard], context: room });
  assert.equal(decision.outcome, 'flag');
  assert.equal(reply(decision), undefined);
  items += 1;
}

console.log(`published self-harm pack passes: ${items} items`);
