# Farcaster channel

This pack gives an agent tools to publish casts, reply, like, recast, search and read feeds on Farcaster using the Neynar API through `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-farcaster
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-channel-farcaster';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    signerUuid: process.env.FARCASTER_SIGNER_UUID,
    neynarApiKey: process.env.NEYNAR_API_KEY,
    fid: process.env.FARCASTER_FID
      ? parseInt(process.env.FARCASTER_FID)
      : undefined,
  },
}));
```

## Configuration

Options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`. Secret and environment values for `fid` are parsed as decimal integers.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `signerUuid` | `farcaster.signerUuid` | `FARCASTER_SIGNER_UUID` | Yes | `''` |
| `neynarApiKey` | `farcaster.neynarApiKey` | `NEYNAR_API_KEY` | Yes | `''` |
| `fid` | `farcaster.fid` | `FARCASTER_FID` | No | Unset |
| `secrets` | None | None | No | `context.secrets`, then `{}` |

## Tools

| Tool | What it does |
| --- | --- |
| `farcasterCast` | Publishes a cast with optional embeds and channel targeting. |
| `farcasterFeed` | Retrieves following or trending casts. |
| `farcasterLike` | Likes a Farcaster cast. |
| `farcasterRecast` | Shares a Farcaster cast. |
| `farcasterReply` | Replies to a Farcaster cast. |
| `farcasterSearch` | Searches casts matching a query. |

### `farcasterCast`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Cast text content |
| `embeds` | array of string | No | URLs to embed in the cast |
| `channelId` | string | No | Farcaster channel ID to post in (e.g. "ethereum") |

### `farcasterFeed`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string: `following`, `trending` | No | Feed type (default "following") |
| `limit` | number | No | Max casts to return (default 20) |

### `farcasterLike`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `castHash` | string | Yes | Hash of the cast to like |

### `farcasterRecast`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `castHash` | string | Yes | Hash of the cast to recast |

### `farcasterReply`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `parentHash` | string | Yes | Hash of the cast to reply to |
| `text` | string | Yes | Reply text |

### `farcasterSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query |
| `limit` | number | No | Max results to return (default 10) |

## Channel adapter

The adapter registers platform `farcaster` and initializes the Neynar HTTP client. Sending publishes the first text block, embeds URLs from image and link blocks, passes `replyToMessageId` as the parent cast hash and reads `platformOptions.channelId` for channel targeting. Reactions create likes. The adapter stores event handlers but does not fetch or dispatch inbound events. Typing indicators do nothing.

## Notes

Publishing, replying, liking and recasting create remote content or reactions. The exported service also exposes `deleteCast`, which deletes a cast using the signer UUID and target hash.

Activation tries `FileTokenStore` from `@framers/agentos/auth` when the Neynar API key is missing. It reads the API key from the stored access token and missing signer UUID and FID from metadata. Initialization throws if the API key or signer UUID is missing.

The configured `fid` is used for user lookup and as a fallback author FID in publish results. Feed requests do not pass it to Neynar.

## License

Apache-2.0
