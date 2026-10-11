# Diarization

This pack registers a speaker diarization engine for the AgentOS voice pipeline. It uses local audio feature extraction and cosine similarity, or consumes speaker labels from speech-to-text transcript events.

## Installation

```bash
npm install @framers/agentos-ext-diarization
```

Peer dependencies: `@framers/agentos` (`>=0.10.40`) and optional `onnxruntime-node` (`^1.18.0`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-diarization';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({}));
```

## Configuration

The pack factory ignores its context. These settings belong to the engine's `startSession` method. It reads no secrets or environment variables.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `backend` | None | None | No | `local` |
| `similarityThreshold` | None | None | No | `0.7` |
| `chunkSizeMs` | None | None | No | `1500` milliseconds |
| `overlapMs` | None | None | No | `500` milliseconds |
| `sampleRate` | None | None | No | `16000` Hz |
| `expectedSpeakers` | None | None | No | Unset; declared but not read by `startSession` |

The exported `ClusteringStrategy` accepts `mergeThreshold`, defaulting to `0.85`, and its `mergeClusters` method accepts optional `expectedSpeakers`. Sessions do not invoke this strategy.

## Notes

Local sessions accept PCM samples in `Float32Array` frames through `pushAudio`, emit `speaker_identified`, and label transcripts with the most recently identified speaker. `enrollSpeaker` registers a reference voiceprint and overwrites an existing voiceprint with the same identifier. Local feature extraction is a placeholder for demos and testing. It uses no ONNX model. Local transcript end times are estimated from text length, and confidence is fixed.

Provider sessions ignore audio and enrollment calls. `labelTranscript` selects the most frequent word-level speaker label and returns `null` when labels are absent. Both backends emit `segment_ready` for a labelled transcript.

The overlap must produce fewer samples than the chunk size, or session creation throws a `RangeError`. The extractor uses the configured sample rate without resampling incoming frames. `close` stops local processing, clears listeners, and causes subsequent audio and transcript inputs to be ignored.

## License

Apache-2.0
