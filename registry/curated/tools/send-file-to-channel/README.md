# Send File to Channel

Send a local file to the user via the current chat channel (Telegram, WhatsApp, Discord, Slack).

## Installation

```bash
npm install @framers/agentos-ext-send-file-to-channel
```

## Usage

```typescript
import { createExtensionPack } from '@framers/agentos-ext-send-file-to-channel';

const pack = createExtensionPack();
```

## Tool: `send_file_to_channel`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filePath` | string | Yes | Absolute path to the file to send |
| `caption` | string | No | Message to accompany the file |

### Example

```
User: "Send me pic.png from my Downloads"
Tool calls:
  1. local_file_search({ query: "pic.png" })
  2. send_file_to_channel({ filePath: "/Users/me/Downloads/pic.png", caption: "Here's your file!" })
```

## Platform File Size Limits

| Platform | Limit |
|----------|-------|
| Telegram | 50 MB |
| WhatsApp (Cloud API) | 100 MB |
| WhatsApp (Twilio) | 16 MB |
| Discord | 25 MB |
| Slack | 1 GB |

When a file exceeds the platform limit, the tool returns an error suggesting compression:

> "File is 60.0MB but telegram limit is 50MB. Would you like me to compress it first?"

## Channel Context

This tool requires a `ChannelContext` to be injected by the `ChatTaskResponder`. It only works when invoked via a messaging channel — not in CLI or API mode.

## License

Apache-2.0
