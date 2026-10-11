# Semantic endpoint detection

This pack registers a turn endpoint detector for the AgentOS voice pipeline. It combines punctuation and acknowledgement rules with turn-completeness classification through a supplied LLM callback.

## Installation

```bash
npm install @framers/agentos-ext-endpoint-semantic
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-endpoint-semantic',
        options: {
          timeoutMs: 500,
          minSilenceBeforeCheckMs: 500,
          silenceTimeoutMs: 1500,
        },
      },
    ],
  },
});
```

This example uses the factory's fallback callback. Supply a context-level `llmCall` function with signature `(prompt: string) => Promise<string>` to enable LLM classification.

## Configuration

The pack reads no secrets or environment variables.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `llmCall` (context field) | None | None | No | Callback resolving to `INCOMPLETE (no llmCall provided)` |
| `timeoutMs` | None | None | No | `500` milliseconds |
| `minSilenceBeforeCheckMs` | None | None | No | `500` milliseconds |
| `silenceTimeoutMs` | None | None | No | `1500` milliseconds |
| `model` | None | None | No | Unset; declared but not read by the detector |

## Notes

The detector accepts final transcripts through `pushTranscript` and VAD transitions through `pushVadEvent`. Interim transcripts are ignored. Recognized acknowledgements emit `backchannel_detected` without replacing the stored transcript. Terminal punctuation triggers `turn_complete` on `speech_end`.

For text without terminal punctuation, the detector delays classification by `minSilenceBeforeCheckMs`. A response beginning with `COMPLETE` ends the turn with reason `semantic_model`. Other responses, callback failures and classification timeouts leave the silence fallback active. Missing `llmCall` uses that fallback without making an LLM request.

The callback receives a prompt containing the transcript. Classification results are cached by transcript prefix and evicted in insertion order. Conversation context is not part of the cache key. The detector does not pass conversation context or a model identifier to the callback. Its timeout stops waiting without cancelling the callback's request.

Resumed speech cancels pending detector timers. Turn completion resets detector state before emitting the event, and `reset` also clears state and timers.

## License

Apache-2.0
