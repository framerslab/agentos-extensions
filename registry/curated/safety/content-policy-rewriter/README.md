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
