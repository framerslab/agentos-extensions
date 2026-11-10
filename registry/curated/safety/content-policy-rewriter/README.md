# @framers/agentos-ext-content-policy-rewriter

Opt-in content policy guardrail for AgentOS — detects violations in agent output and either blocks or rewrites them to compliant versions via LLM judge.

**Agents are uncensored by default.** This extension only activates when explicitly configured.

## Features

- **Two-layer hybrid pipeline:** keyword pre-filter on streaming chunks (zero-cost) + LLM judge/rewriter on final response
- **8 configurable categories:** illegal_harmful, adult, profanity, violence, self_harm, hate_speech, illegal_activity, custom
- **4 presets:** uncensored, uncensored-safe, family-friendly, enterprise
- **Fully configurable:** every category can be enabled/disabled, action set to block or sanitize
- **No hardcoded restrictions:** all policies are user-controlled

## Quick Start

```typescript
import { createContentPolicyRewriter } from '@framers/agentos-ext-content-policy-rewriter';

// Minimal — blocks illegal_harmful content only (default)
const pack = createContentPolicyRewriter({});

// Family-friendly preset
const pack = createContentPolicyRewriter('family-friendly');

// Custom configuration
const pack = createContentPolicyRewriter({
  categories: {
    adult: { enabled: true, action: 'sanitize' },
    profanity: { enabled: true, action: 'sanitize' },
    violence: { enabled: true, action: 'block' },
  },
  customRules: 'Never mention competitor products by name.',
});

// Truly uncensored — zero filtering
const pack = createContentPolicyRewriter('uncensored');
```

## What it judges

The guard reads the chunks of an AgentOS output stream as the runtime emits them (`AgentOSResponseChunkType`):

- **Text deltas** (`type: 'text_delta'`, text in `textDelta`): the keyword pre-filter scans each delta together with the last words of the stream's earlier deltas, so a phrase split across two deltas is found. Block categories are tried first. A match in a `block` category ends the stream with an error chunk whose `code` is `KEYWORD_<CATEGORY>`; a match in a `sanitize` category replaces the delta with `[Content removed by policy]`. The pre-filter is broad on purpose: a delta that ends partway through a word is scanned as it is, so a word cut at a delta's end can match a keyword it only begins with. Set `streamingPreFilter: false` to skip deltas, and pass `holdUntilFinal` to the output dispatcher to show nothing before the whole reply is judged.
- **The final response** (`type: 'final_response'`, text in `finalResponseText`): a keyword match in any `block` category blocks at once, with no LLM call. Otherwise the LLM judge classifies the text against the enabled categories; violations of a category that is not enabled are ignored. Any violation in a `block` category blocks the reply, with the categories as the reason code. When every violation is in a `sanitize` category, the LLM rewriter writes the replacement and the guard returns it as a `sanitize`; when the rewrite call fails or returns no text the reply is blocked with `REWRITE_FAILED`.
- **When the judge cannot classify** (the call fails, or the answer is not the asked JSON), the reply is blocked with `JUDGE_FAILED`. Set `judgeFailure: 'allow'` to let such a reply pass instead.

Every other chunk passes unjudged. A host that calls `evaluateOutput()` itself passes the same chunk shapes.

## agent.config.json

```json
{
  "guardrails": {
    "contentPolicy": {
      "enabled": true,
      "categories": {
        "illegal_harmful": { "enabled": true, "action": "block" },
        "adult": { "enabled": true, "action": "sanitize" },
        "profanity": { "enabled": true, "action": "sanitize" }
      }
    }
  }
}
```

Or shorthand:

```json
{
  "guardrails": {
    "contentPolicy": "uncensored-safe"
  }
}
```

## Categories

| Category | Description | Default |
|---|---|---|
| `illegal_harmful` | CSAM, sexual assault, bestiality, exploitation | enabled, block |
| `adult` | Consensual sexually explicit content | disabled |
| `profanity` | Slurs, vulgar language | disabled |
| `violence` | Graphic violence, gore | disabled |
| `self_harm` | Self-harm, suicide instructions | disabled |
| `hate_speech` | Discriminatory, bigoted content | disabled |
| `illegal_activity` | Drug synthesis, weapons manufacturing | disabled |
| `custom` | User-defined policy rules | disabled |

## Presets

| Preset | Effect |
|---|---|
| `uncensored` | All categories disabled — zero filtering |
| `uncensored-safe` | Only `illegal_harmful` enabled |
| `family-friendly` | All categories enabled (sanitize where possible) |
| `enterprise` | All categories enabled + custom rules |

## License

Apache-2.0
