# @framers/agentos-ext-self-harm-referral

An input and output guardrail for [AgentOS](https://github.com/framerslab/agentos). By default, when a person's message, or an agent's reply, expresses suicide or self-harm, the guard answers with crisis lines for the person's country, stops the turn so the topic does not go on, and reports a `referral_sent` event the host counts.

```bash
npm install @framers/agentos-ext-self-harm-referral @framers/agentos
```

```ts
import { AgentOS } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-self-harm-referral';

let referrals = 0;

const agentos = new AgentOS();
await agentos.initialize({
  // ...
  extensionManifest: {
    packs: [
      {
        factory: () =>
          createExtensionPack({
            options: {
              judgeModel: { provider: 'openai' },
              onEvent: () => {
                referrals += 1;
              },
            },
          }),
      },
    ],
  },
  // Holds every streamed delta until the guards have judged the whole reply, so a replaced reply never shows.
  requiredGuardrails: [{ id: 'self-harm-referral', stages: ['input', 'output'], timeoutMs: 10_000 }],
});
```

## What it does

| Where | What the guard returns | What the person receives |
| --- | --- | --- |
| A person's message (`evaluateInput`, default `reply` delivery) | `BLOCK`, reason code `SELF_HARM_REFERRAL`, the referral in both `reason` and `replacementText` | AgentOS runs no model turn and answers with one final chunk of type `ERROR`, whose `code` is `SELF_HARM_REFERRAL` and whose `message` is the referral |
| An agent's final reply (`evaluateOutput`, `reply` delivery) | the same `BLOCK` | AgentOS sends a final response holding the referral in place of the reply |
| A person's message in `private` delivery, confirmed by a judge | `FLAG`, reason code `SELF_HARM_REFERRAL`, with `metadata.privateReply` | The host delivers the referral to the speaker alone |
| A matched room message without confirmation or a recipient id | `FLAG`, reason code `SELF_HARM_UNCONFIRMED` | No referral; the host reviews the item |
| Anything else | `null` | the turn as it was |

Each referral calls the host's `onEvent` with an event that holds no words of the person's or the agent's:

```ts
{
  type: 'referral_sent',
  guardrailId: 'self-harm-referral',
  stage: 'input',            // or 'output'
  country: 'GB',             // the country whose lines led, or null
  locale: 'en-GB',           // the locale the country was read from, or null
  lineIds: ['gb-samaritans', 'us-988', 'findahelpline'],
  method: 'keyword_and_judge', // or 'keyword' when no judge is configured
  judgeOutcome: 'confirmed', // 'none' | 'confirmed' | 'unsure' | 'failed'
  tableVersion: '2026-11-04',
  sessionId: 'session-1',
  conversationId: 'conversation-1',
  occurredAt: '2026-11-04T12:00:00.000Z',
}
```

In `reply` delivery, the event says the guard answered with a referral. AgentOS sends that answer to the person: the guard runs in AgentOS's first phase (`canSanitize`, though it never sanitizes), where a `BLOCK` ends the evaluation before any classifier runs. A sanitizer registered before it that blocks the same message answers instead, the guard never runs, and no event fires. Two cases are the host's to know: a host that hides `ERROR` chunks hides an input referral, and a required guard whose `timeoutMs` passes before the judge's deadline has already blocked with no referral when the event fires ("Using reply delivery well" says how to avoid both).

The verdict's `metadata` carries the same fields, the session and conversation ids and the time included, with `event: 'referral_sent'` in place of `type` and the keyword list's version in `phraseListVersion`. A host that does not take `onEvent` counts referrals from the stream, by the reason code:

| Stage | Where the fields are |
| --- | --- |
| A person's message | the final `ERROR` chunk `processRequest` yields: `code` is `SELF_HARM_REFERRAL`, `message` is the referral, `details.metadata` holds the fields |
| An agent's reply | the final response chunk: `metadata.guardrail.output[0]` holds `reasonCode` (`SELF_HARM_REFERRAL`) and the fields under `metadata`. A caller of `wrapOutputGuardrails` also gets its `onVerdict` with the `reasonCode`; `processRequest` sets its own `onVerdict`, so a host of `AgentOS` reads the chunk |

`onVerdict` fires only in `wrapOutputGuardrails`, so it never sees an input referral: a host that counts through it misses every one. The guard also counts its own referrals in `referralsSent`, and writes one line per referral through the host's logger, with the stage, the country and the method. A judge's clearing writes one line too, with the guard's id, the stage and the judge's confidence, since a clearing withholds a referral and leaves no event. A judge or event-handler failure logs `errorName: 'unknown'` in both delivery modes: both a supplied error name and its message can repeat the person's words. No line holds the person's words.

## In a room: private delivery

Set `delivery: 'private'` when the host needs a referral for the speaker of a room message. A `judge` or `judgeModel` is required. The guard evaluates input alone; configuring an output stage throws.

A keyword match the judge confirms with a confidence at or above `judgeThreshold` returns `FLAG` with reason code `SELF_HARM_REFERRAL`. Its `metadata.privateReply` contains `{ recipientId, text, lineIds }`. The recipient is `context.moderation.sender.id`; when the context names no sender, the writer is the user the call runs for (as AgentOS's `ModerationContext` defines `sender`), and the recipient is `context.userId`. The host sends the text to that person alone and files its review item; the guard itself performs no delivery. Never broadcast the private reply to the room. The `referral_sent` event also carries `delivery: 'private'` and `recipientId`.

An unsure judge (a clearing or a confirmation below `judgeThreshold`), a failed request or a timeout sends no referral. Instead the guard returns `FLAG` with `SELF_HARM_UNCONFIRMED` and `metadata.judgeOutcome` (`unsure` or `failed`), for the host to put before a person. A confirmed match with no person to send it to also returns this flag, with `judgeOutcome: 'confirmed'`: a sender whose `kind` is `agent`, a sender with no usable id (the guard never falls back to `context.userId` once a sender is named), or no id at all. A match the judge clears passes. The guard never blocks or holds a room message and fails open on an unexpected fault; the host's other guards decide the message itself. Both delivery modes list the two reason codes in `config.reasonCodes`.

The guard names its own deadline in this mode: `config.timeoutMs` is `judgeTimeoutMs` plus one second. A `moderateContent()` call gives a guard with no deadline of its own the call's `timeoutMs` (8 seconds by default) and drops a guard that runs open when it passes, so without its own deadline a slow judge would let the item pass with no flag. With it, the judge's deadline always ends first and the guard flags the item. Set `judgeTimeoutMs` to bound how long the guard can take.

```ts
import { moderateContent } from '@framers/agentos';
import { SelfHarmReferralGuardrail } from '@framers/agentos-ext-self-harm-referral';

const guard = new SelfHarmReferralGuardrail({
  delivery: 'private',
  judgeModel: { provider: 'openai' },
});
const decision = await moderateContent({ text: messageText }, {
  guards: [guard],
  context: {
    userId: 'moderation-account',
    sessionId: 'session-1',
    moderation: {
      surface: 'public_room',
      roomId: 'room-1',
      sender: { id: 'speaker-1', kind: 'account' },
    },
    metadata: { country: 'GB' },
  },
});
const evaluation = decision.evaluations.find(
  (item) => item.metadata?.guardrailId === guard.id,
);
const privateReply = evaluation?.metadata?.privateReply;
// The host delivers privateReply to its recipientId alone, when present.
```

This example uses `moderateContent()` and the typed sender context from `@framers/agentos` 0.17.1 or later. The pack's peer floor remains `>=0.13.121`; existing reply delivery needs no new core API.

When the host's own classifier has already confirmed self-harm, use `createPrivateReferral()` to build the same text, line ids and event without another judge call:

```ts
import { createPrivateReferral } from '@framers/agentos-ext-self-harm-referral';

const referral = createPrivateReferral({ recipientId: 'speaker-1', country: 'GB' });
// Deliver referral.text to referral.recipientId alone and record referral.event.
```

The builder detects nothing and calls no handler. Its event has `method: 'classifier'`, `judgeOutcome: 'confirmed'`, `stage: 'input'` and `delivery: 'private'`. Its `PrivateReferralInput` accepts `recipientId`, `country`, `locale`, a replacement `table`, `guardrailId`, `sessionId`, `conversationId` and a `now` clock. Country resolution and the returned text are the same as the guard's.

Private delivery deliberately sends nothing when a judge is down. The keyword list can match game talk such as “how do I die in this level”; an unconfirmed crisis referral in that setting can itself be harmful. Default `reply` delivery continues to favor a referral when the judge cannot clear a match. Both modes use the same English-only list and referral table covering six countries.

## How it detects

1. **A keyword list** ([`src/phrases.ts`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/safety/self-harm-referral/src/phrases.ts)) of first-person expressions and, on replies only, the second-person forms an agent uses to carry the topic on (`end your life`, `hurt yourself`). It covers wishes and intentions with the words people put inside them (`I wish I could die`, `I want to fucking die`), ending-it phrasing (`I just want to end it`), acts in every tense (`I cut my wrists`, `I keep burning myself`), questions about methods and amounts (`how many pills does it take to die`), means (`I want to jump off a bridge`), and the warning signs in the sources below (`I'm a burden`, `no reason to live`), with the contractions, slang and misspellings people type. It matches over the text as AgentOS's `normalizePhraseText` leaves it: lower case, look-alike Cyrillic and Greek letters mapped to Latin, zero-width characters and combining marks removed, quotes straightened, whitespace collapsed. A text that matches no entry passes without a model call, so a phrase has to be on the list to reach the judge. The list leans toward matching for default reply delivery, where a missed referral can cost far more than an unnecessary one; private delivery requires confirmation before producing a referral.
2. **A model judge**, when the host gives one: `judge` (any AgentOS `PhraseJudge`) or `judgeModel` (the host's provider and model, built with AgentOS's `createLlmPhraseJudge` and the criteria in `SELF_HARM_JUDGE_CRITERIA`). It reads each matched text in context and clears figurative uses (`I could kill myself laughing`), titles and factual mentions.
3. **In default `reply` delivery, the referral stands unless the judge clears the match with confidence**: a judge that throws, answers nothing usable, takes longer than `judgeTimeoutMs`, or clears below `judgeThreshold` leaves the referral in place. With no judge, every match sends the referral.

The `@framers/agentos-ext-ml-classifiers` pack has no self-harm label: its categories are `toxic`, `injection`, `nsfw` and `threat`, and `threat` joins threats of violence with self-harm instructions (its `ClassifierCategory` type, [`src/types.ts`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/safety/ml-classifiers/src/types.ts)). This pack starts from the keyword list and the judge instead. Whether this method meets a particular law's or standard's test for an evidence-based protocol is an open question; the method is named here so a host can describe it.

The wording starts from published screening questions and warning signs, put in the first person:

- [The Columbia Protocol](https://cssrs.columbia.edu/wp-content/uploads/Columbia_Protocol.pdf): wishing to be dead or to go to sleep and not wake up, thoughts of killing oneself, and its examples of preparing (`took pills`, `cut yourself`, `tried to hang yourself`, `collected pills`, `gave away valuables`, `suicide note`). [About the scale](https://cssrs.columbia.edu/the-columbia-scale-c-ssrs/about-the-scale/) explains why its questions use plain and direct language.
- [NIMH's ASQ](https://www.nimh.nih.gov/sites/default/files/documents/research/research-conducted-at-nimh/asq-toolkit-materials/asq-tool/screening-tool-asq-nimh-toolkit.pdf): wishing to be dead, `better off if you were dead`, thoughts of killing oneself.
- [PHQ-9, item 9](https://www.apa.org/depression-guideline/patient-health-questionnaire.pdf): `better off dead`, `hurting yourself in some way`.
- Warning signs from [NIMH](https://www.nimh.nih.gov/health/publications/warning-signs-of-suicide) and [AFSP](https://afsp.org/risk-factors-protective-factors-and-warning-signs/): wanting to die, being a burden to others, no reason to live, researching ways to die, giving things away.
- Kinds of self-harm from [NHS inform](https://www.nhsinform.scot/illnesses-and-conditions/mental-health/self-harm/) and [Rethink Mental Illness](https://www.rethink.org/advice-and-information/about-mental-illness/learn-more-about-symptoms/self-harm/): cutting, burning, punching, poisoning, scratching, hitting, biting, overdosing.

The slang, the misspellings, the intensifiers and the named heights and vehicles come from how people type, not from those sources, and no source validates this list as a screening instrument.

## The lines

The lines live in [`src/referral-lines.json`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/safety/self-harm-referral/src/referral-lines.json), each with the page that states its number, read on the day in `reviewedAt`. A referral names the lines of the turn's country, then the United States' 988 line, then [Find A Helpline](https://findahelpline.com/) for anywhere else, and closes with the country's emergency number, or with "call your local emergency number" when the country is unknown.

| Country | Line | Emergency | Source |
| --- | --- | --- | --- |
| United States | call or text 988, or chat at 988lifeline.org | 911 | [SAMHSA, 988 FAQs](https://www.samhsa.gov/mental-health/988/faqs) |
| Canada | call or text 9-8-8 | 9-1-1 | [988.ca](https://988.ca/) |
| United Kingdom | Samaritans, 116 123 | 999 | [Samaritans](https://www.samaritans.org/how-we-can-help/contact-samaritan/), [NHS](https://www.nhs.uk/nhs-services/mental-health-services/where-to-get-urgent-help-for-mental-health/) |
| Ireland | Samaritans, 116 123; text HELLO to 50808 | 112 or 999 | [HSE supports](https://www2.hse.ie/mental-health/services-support/supports-services/), [HSE urgent help](https://www2.hse.ie/mental-health/services-support/get-urgent-help/) |
| Australia | Lifeline, 13 11 14; text 0477 13 11 14 | 000 | [Lifeline](https://www.lifeline.org.au/) |
| New Zealand | call or text 1737 | 111 | [1737](https://1737.org.nz/) |

The country is the first of these that names one:

1. `context.metadata.country`, an ISO 3166-1 alpha-2 code (`UK` reads as `GB`);
2. the region of `context.metadata.locale`, a BCP 47 locale such as a channel reports (`en-GB` from Discord, `en_gb`; a locale with no region, such as `de`, or a numeric one, such as `es-419`, names no country);
3. on a person's message, the region of the input's `languageHint`;
4. the pack's `country` option, then the region of its `locale` option.

A country the table does not hold ends the search: the person gets 988, Find A Helpline and the local-emergency sentence, since a later entry or the pack's default would give them the emergency number of a country they are not in. A value that names no country (`Germany`, a locale with no region) is read past. A host that knows the person's country sets `country` on the turn, because a channel's locale is a language setting and can name a country the person has left.

AgentOS builds `context.metadata` from the request's `options.customFlags`, so a host sets both on `processRequest`:

```ts
for await (const chunk of agentos.processRequest({
  userId,
  sessionId,
  textInput,
  options: { customFlags: { country: 'GB', locale: 'en-GB' } },
})) {
  // ...
}
```

A host with its own table passes `table` in the same shape. To change a line, read its source page again and update the line, its `source` and `reviewedAt`.

## Options

Passed as `createExtensionPack({ options })` or `new SelfHarmReferralGuardrail(options)`.

| Option | Default | |
| --- | --- | --- |
| `id` | `self-harm-referral` | the guard's id, on its descriptor and its verdicts |
| `delivery` | `reply` | `private` requires a judge and returns flags with a referral for the speaker only after confirmation |
| `stages` | `['input', 'output']` in `reply`; `['input']` in `private` | the stages it evaluates; private delivery rejects `output` |
| `judge` | none | a `PhraseJudge` the host built |
| `judgeModel` | none | `{ provider, model, apiKey?, baseUrl? }` for a judge on the host's provider; a provider other than `openai` needs a model |
| `judgeThreshold` | `0.7` | the confidence at or above which the judge's clearing counts; in `private`, its confirmation too |
| `judgeTimeoutMs` | `6000` | the judge's deadline; expiry sends a referral in `reply`, and flags without one in `private`, where the guard's own `config.timeoutMs` is this plus one second |
| `country`, `locale` | none | the place used when the turn names no country |
| `table` | the shipped table | a table of the same shape |
| `extraPhrases` | none | AgentOS `PhraseEntry` items added on both stages |
| `onEvent` | none | called with each `referral_sent` event; the guard does not wait on it, so a handler that throws, rejects or never settles does not hold the referral back |
| `logger` | the pack context's logger | where the guard writes its lines; a logger that throws does not stop a referral |

## Using reply delivery well

- **Hold the output.** The guard judges final replies. With AgentOS streaming deltas (`guardrailOutputMode: 'stream'`), the reply's text reaches the person before the final verdict replaces it. Either step makes the deltas wait for the verdict: require the guard on `output` (AgentOS turns hold mode on whenever a required guard names that stage, from the peer floor 0.13.121 on), or set `guardrailOutputMode: 'hold'`.
- **Show the referral.** On a person's message the referral arrives as an `ERROR`-type chunk, so a host that hides error chunks or swaps their messages for its own hides the crisis lines: show `message` when `code` is `SELF_HARM_REFERRAL`. A host that evaluates guards itself sends the verdict's `replacementText` and does not show a generic refusal in its place.
- **Register it first.** The guard runs in AgentOS's first phase, so its `BLOCK` answers ahead of every classifier, whatever their order. Sanitizers run in that phase too, in registration order: one registered before this guard that blocks the same message answers in its place, and the person never sees the lines. A guard's position is its pack's position in `extensionManifest.packs`; `@framers/agentos-extensions-registry` lists this one ahead of the other guards it names.
- **Give a required guard a deadline above the judge's.** A required guard that passes its `timeoutMs` blocks with no replacement text, and the guard's event fires later for a referral nobody saw. `judgeTimeoutMs` defaults to 6000 ms; the example above gives the guard 10000 ms.

## Limits

- The keyword list and the referral are in English. A message in another language passes unless it uses a listed phrase, since the judge reads only texts the list matched.
- An expression that uses none of the listed phrases passes. `extraPhrases` widens the list.
- A message about someone else's risk (`my friend wants to die`) passes unless it uses a listed phrase, since the list is written in the first person.
- In `reply` delivery with no judge, the list over-matches on purpose: every match sends the referral, including `I can't go on Friday`, `I burned myself on the stove`, `I want to end it with my boyfriend`, `I'd rather die than eat there` and `how do I die in this level`. A judge clears these. A host that cannot accept that sets `judge` or `judgeModel`.
- A judge reads only what the list matched, so it cannot widen the list; it can only clear a match.
- The table holds six countries. Every other country gets 988, Find A Helpline and the local-emergency sentence.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
