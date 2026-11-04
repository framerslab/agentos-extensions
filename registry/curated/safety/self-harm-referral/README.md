# @framers/agentos-ext-self-harm-referral

An input and output guardrail for [AgentOS](https://github.com/framerslab/agentos). When a person's message, or an agent's reply, expresses suicide or self-harm, the guard answers with crisis lines for the person's country, stops the turn so the topic does not go on, and reports a `referral_sent` event the host counts.

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
| A person's message (`evaluateInput`) | `BLOCK`, reason code `SELF_HARM_REFERRAL`, the referral in both `reason` and `replacementText` | AgentOS runs no model turn and answers with one final chunk of type `ERROR`, whose `code` is `SELF_HARM_REFERRAL` and whose `message` is the referral |
| An agent's final reply (`evaluateOutput`) | the same `BLOCK` | AgentOS sends a final response holding the referral in place of the reply |
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

The verdict's `metadata` carries the same fields, the session and conversation ids and the time included, with `event: 'referral_sent'` in place of `type` and the keyword list's version in `phraseListVersion`, so a host that reads verdicts (AgentOS's `onVerdict`, or the guardrail metadata on the chunk) can count referrals by the reason code. The guard also counts its own referrals in `referralsSent`, and writes one line per referral through the host's logger, with the stage, the country and the method. A judge failure is logged by its kind and the error's name, never its message, since a provider's error can repeat the text it was sent.

## How it detects

1. **A keyword list** ([`src/phrases.ts`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/safety/self-harm-referral/src/phrases.ts)) of first-person expressions (`kill myself`, `want to die`, `end my life`, `self-harm`, `better off without me`, `don't want to wake up`, `not worth living`, `suicidal`, ..., with the contractions, slang and misspellings people type) and, on replies only, the second-person forms an agent uses to carry the topic on (`end your life`, `hurt yourself`). It matches over the text as AgentOS's `normalizePhraseText` leaves it: lower case, look-alike Cyrillic and Greek letters mapped to Latin, zero-width characters removed, quotes straightened. A text that matches no entry passes without a model call.
2. **A model judge**, when the host gives one: `judge` (any AgentOS `PhraseJudge`) or `judgeModel` (the host's provider and model, built with AgentOS's `createLlmPhraseJudge` and the criteria in `SELF_HARM_JUDGE_CRITERIA`). It reads each matched text in context and clears figurative uses (`I could kill myself laughing`), titles and factual mentions.
3. **The referral stands unless the judge clears the match with confidence**: a judge that throws, answers nothing usable, takes longer than `judgeTimeoutMs`, or clears below `judgeThreshold` leaves the referral in place. With no judge, every match sends the referral.

The `@framers/agentos-ext-ml-classifiers` pack has no self-harm label: its categories are `toxic`, `injection`, `nsfw` and `threat`, and `threat` joins threats of violence with self-harm instructions (its `ClassifierCategory` type, [`src/types.ts`](https://github.com/framerslab/agentos-extensions/blob/master/registry/curated/safety/ml-classifiers/src/types.ts)). This pack starts from the keyword list and the judge instead. Whether this method meets a particular law's or standard's test for an evidence-based protocol is an open question; the method is named here so a host can describe it.

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

The country is the first of these the table holds:

1. `context.metadata.country`, an ISO 3166-1 alpha-2 code (`UK` reads as `GB`);
2. the region of `context.metadata.locale`, a BCP 47 locale such as a channel reports (`en-GB` from Discord, `en_gb`; a locale with no region, such as `de`, or a numeric one, such as `es-419`, names no country);
3. on a person's message, the region of the input's `languageHint`;
4. the pack's `country` option, then the region of its `locale` option.

A host with its own table passes `table` in the same shape. To change a line, read its source page again and update the line, its `source` and `reviewedAt`.

## Options

Passed as `createExtensionPack({ options })` or `new SelfHarmReferralGuardrail(options)`.

| Option | Default | |
| --- | --- | --- |
| `id` | `self-harm-referral` | the guard's id, on its descriptor and its verdicts |
| `stages` | `['input', 'output']` | the stages it evaluates |
| `judge` | none | a `PhraseJudge` the host built |
| `judgeModel` | none | `{ provider, model, apiKey?, baseUrl? }` for a judge on the host's provider; a provider other than `openai` needs a model |
| `judgeThreshold` | `0.7` | the confidence at or above which the judge's clearing counts |
| `judgeTimeoutMs` | `6000` | the judge's deadline; past it the referral is sent |
| `country`, `locale` | none | the place used when the turn names none |
| `table` | the shipped table | a table of the same shape |
| `extraPhrases` | none | AgentOS `PhraseEntry` items added on both stages |
| `onEvent` | none | called with each `referral_sent` event; the guard does not wait on it, so a handler that throws, rejects or never settles does not hold the referral back |
| `logger` | the pack context's logger | where the guard writes its lines; a logger that throws does not stop a referral |

## Using it well

- **Hold the output.** The guard judges final replies. With AgentOS streaming deltas (`guardrailOutputMode: 'stream'`), the reply's text reaches the person before the final verdict replaces it. Either step makes the deltas wait for the verdict: require the guard on `output` (AgentOS turns hold mode on whenever a required guard names that stage, from the peer floor 0.13.121 on), or set `guardrailOutputMode: 'hold'`.
- **Show the referral.** On a person's message the referral arrives as an `ERROR`-type chunk, so a host that hides error chunks or swaps their messages for its own hides the crisis lines: show `message` when `code` is `SELF_HARM_REFERRAL`. A host that evaluates guards itself sends the verdict's `replacementText` and does not show a generic refusal in its place.
- **Register it first.** AgentOS answers a blocked message with the first `BLOCK` in registration order, so a guard registered earlier that blocks the same message answers in its place.
- **Give a required guard a deadline above the judge's.** A required guard that passes its `timeoutMs` blocks with no replacement text.

## Limits

- The keyword list and the referral are in English. A message in another language passes unless it uses a listed phrase, since the judge reads only texts the list matched.
- An expression that uses none of the listed phrases passes. `extraPhrases` widens the list.
- The table holds six countries. Every other country gets 988, Find A Helpline and the local-emergency sentence.

## License

Apache-2.0
