# Nostr channel

This pack gives an agent a text messaging tool and a channel adapter for encrypted Nostr direct messages. It uses `nostr-tools` and WebSocket relay connections.

## Installation

```bash
npm install @framers/agentos-ext-channel-nostr
```

Peer dependency: `@framers/agentos` at `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-nostr',
        options: {
          privateKey: process.env.NOSTR_PRIVATE_KEY,
          relayUrls: process.env.NOSTR_RELAY_URLS,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from options, then `options.secrets`, then the environment. `relayUrls` accepts an array or a comma-separated string.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `privateKey` | `nostr.privateKey` | `NOSTR_PRIVATE_KEY` | yes | None |
| `relayUrls` | `nostr.relayUrls` | `NOSTR_RELAY_URLS` | yes, in manifest | `wss://relay.damus.io`, `wss://nos.lol` |
| `priority` | None | None | no | `50` |
| `secrets` | Credential ids above | None | no | None |

## Tools

| Tool | What it does |
| --- | --- |
| `nostrChannelSendMessage` | Sends a text message to a Nostr public key in hex or npub format. |

### `nostrChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | yes | Target pubkey / conversation identifier |
| `text` | string | yes | Message text |

## Channel adapter

The adapter registers platform `nostr`. Activation subscribes to encrypted direct messages addressed to the derived public key on the configured relays. It verifies inbound events, decrypts their content and emits nonempty text as direct messages, using the sender's public key as the conversation id. Outbound messages encrypt and sign the first text block and publish it to the relays.

## Notes

Sending publishes an encrypted event to the configured relays. The private key accepts hex or nsec format; recipients accept hex or npub format. Missing or invalid private keys make pack creation throw. The manifest requires `nostr.relayUrls`, while the factory supplies default relays when none are configured.

The subscription includes a startup lookback of `120` seconds. Typing indicators do nothing. Deactivation closes the subscription and attempts to close relay connections.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
