# Cloudflare Registrar

This pack gives an agent domain listing, registrar inspection, DNS record management and domain transfers through the Cloudflare API.

## Installation

```bash
npm install @framers/agentos-ext-domain-cloudflare-registrar
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-domain-cloudflare-registrar';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiToken` | `cloudflare.apiToken` | `CLOUDFLARE_API_TOKEN` | Yes | Empty string |
| `accountId` | `cloudflare.accountId` | `CLOUDFLARE_ACCOUNT_ID` | Yes | Empty string |
| `secrets` | | | No | Context `secrets`, then `{}` |
| `baseUrl` (service constructor only) | | | No | `https://api.cloudflare.com/client/v4` |

Credentials resolve from options, then the selected secrets map, then environment variables. The factory does not pass `baseUrl` to the service.

## Tools

| Tool | What it does |
| --- | --- |
| `cfRegListDomains` | Lists registered domains with status, expiry, renewal, lock, privacy and nameservers. |
| `cfRegGetDomainInfo` | Gets registrar details and optionally updates renewal, lock and privacy settings. |
| `cfRegConfigureDns` | Adds, removes, lists or updates DNS records, resolving the zone from the domain. |
| `cfRegTransferDomain` | Initiates a domain transfer to Cloudflare using an authorization code. |

### `cfRegListDomains`

The input schema has no parameters.

### `cfRegGetDomainInfo`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name (e.g. "example.com") |
| `update` | object | No | Optional: update registrar settings (auto-renew, lock, privacy) in the same call |
| `update.autoRenew` | boolean | No | Enable or disable auto-renewal |
| `update.locked` | boolean | No | Enable or disable registrar lock (prevents unauthorized transfers) |
| `update.privacy` | boolean | No | Enable or disable WHOIS privacy |

### `cfRegConfigureDns`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name (e.g. "example.com"). The zone ID is resolved automatically. |
| `action` | string, enum: `add`, `remove`, `list`, `update` | No | Action to perform (default: list) |
| `recordId` | string | No | The DNS record ID (required for remove and update actions) |
| `type` | string, enum: `A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`, `SRV`, `CAA` | No | DNS record type (required for add action) |
| `name` | string | No | Record name (e.g. "www.example.com" or "example.com" for root) |
| `content` | string | No | Record value/content (e.g. IP address, hostname, TXT value) |
| `ttl` | number | No | Time to live in seconds (1 = automatic, default: 1) |
| `priority` | number | No | Priority (required for MX records, optional for others) |
| `proxied` | boolean | No | Whether the record is proxied through Cloudflare (default: false, only for A/AAAA/CNAME) |
| `comment` | string | No | Optional comment for the DNS record |

### `cfRegTransferDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name to transfer (e.g. "example.com") |
| `authCode` | string | Yes | The authorization/EPP code from the current registrar (required to authorize the transfer) |

## Notes

Activation rejects missing credentials and verifies the API token. DNS operations require a matching Cloudflare zone. Adding a record requires `type`, `name` and `content`; removing or updating requires `recordId`.

DNS changes create, update or delete records. A nonempty `update` changes registrar settings. Transfers submit the authorization code to Cloudflare. Tool failures return `success: false` and an `error` message.

## License

Apache-2.0
