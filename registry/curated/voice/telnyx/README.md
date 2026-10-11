# Telnyx voice calls

This pack gives an agent a phone call tool and voice provider using the `telnyx` SDK and Telnyx Call Control. It places outbound calls, speaks text into calls, hangs up calls and normalizes webhook events.

## Installation

```bash
npm install @framers/agentos-ext-voice-telnyx
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-voice-telnyx';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    apiKey: process.env.TELNYX_API_KEY,
    connectionId: process.env.TELNYX_CONNECTION_ID,
    publicKey: process.env.TELNYX_PUBLIC_KEY,
    fromNumber: process.env.TELNYX_FROM_NUMBER,
  },
  logger: console,
}));
```

## Configuration

Credentials resolve from direct options, then `options.secrets`, then the listed environment variables in order.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` | `telnyx.apiKey` | `TELNYX_API_KEY`, `TELNYX_API_V2_KEY` | Yes | None, throws if absent |
| `connectionId` | `telnyx.connectionId` | `TELNYX_CONNECTION_ID`, `TELNYX_APP_ID` | Yes | None, throws if absent |
| `publicKey` | `telnyx.publicKey` | `TELNYX_PUBLIC_KEY` | No | `undefined` |
| `fromNumber` | None | `TELNYX_FROM_NUMBER` | No | `undefined` in service, empty string in manager config |
| `webhookBaseUrl` | None | None | No | `undefined` |
| `priority` | None | None | No | `50` |
| `secrets` | Map containing the secret ids above | None | No | `undefined` |

## Tools

| Tool | What it does |
| --- | --- |
| `telnyxVoiceCall` | Makes and manages phone calls via Telnyx, including outbound calling, in-call TTS, hangup and status queries. |

### `telnyxVoiceCall` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `string`, enum: `call`, `speak`, `hangup`, `status`, `list` | Yes | The voice call action to perform |
| `toNumber` | `string` | No | E.164 phone number to call (required for "`call`" action) |
| `message` | `string` | No | Message to speak (for "`call`" in notify mode, or "`speak`" action) |
| `mode` | `string`, enum: `notify`, `conversation` | No | Call interaction mode (default: "`conversation`") |
| `callId` | `string` | No | Call ID (required for "`speak`", "`hangup`", and "`status`" actions) |

## Notes

The package requires Node.js `>=22`. Activation dynamically loads the SDK and initializes the service. Deactivation disposes the call manager and releases the SDK client reference.

The tool has side effects: `call` places a phone call, `speak` sends a TTS command and `hangup` ends a call. Runtime checks require `toNumber` for `call`, `callId` and `message` for `speak`, and `callId` for `hangup` or `status`. The schema requires only `action`.

The provider uses the configured connection ID, caller number and webhook URL. `notify` enables answering machine detection. `conversation` passes a media stream URL with the inbound track. Call state is encoded into the outbound request. The service defaults TTS to a female voice and `en-US` with a text payload.

The provider parses call initiation, answer, hangup, machine detection and stream connection events. It attempts signature verification when `publicKey` is set and rejects missing signature headers, failed verification or timestamps outside its freshness window. Without `publicKey`, it accepts webhooks without signature verification.

The pack registers `voice-provider` named `telnyx` and delegates call management to `CallManager`. Its files do not start an HTTP webhook listener or implement a media socket server.

## License

Apache-2.0
