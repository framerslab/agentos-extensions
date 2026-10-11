# GoDaddy domain registrar

This pack gives an agent domain availability checks, registration, account listings, DNS management and domain details through the GoDaddy REST API.

## Installation

```bash
npm install @framers/agentos-ext-domain-godaddy
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-domain-godaddy';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    apiKey: process.env.GODADDY_API_KEY,
    apiSecret: process.env.GODADDY_API_SECRET,
    baseUrl: process.env.GODADDY_BASE_URL,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` | `godaddy.apiKey` | `GODADDY_API_KEY` | Yes | Empty string |
| `apiSecret` | `godaddy.apiSecret` | `GODADDY_API_SECRET` | Yes | Empty string |
| `baseUrl` | | `GODADDY_BASE_URL` | No | `https://api.godaddy.com/v1` |
| `secrets` | | | No | Context `secrets`, then `{}` |

Credentials resolve from options, then the selected secrets map, then environment variables. The sandbox URL is `https://api.ote-godaddy.com/v1`.

## Tools

| Tool | What it does |
| --- | --- |
| `godaddySearchDomain` | Checks domain availability and returns pricing, currency and registration period. |
| `godaddyRegisterDomain` | Purchases a domain with registrant contacts, renewal, privacy and nameserver options. |
| `godaddyListDomains` | Lists account domains with status, expiry, renewal and nameservers. |
| `godaddyConfigureDns` | Adds, removes, lists or updates DNS records. |
| `godaddyGetDomainInfo` | Gets expiry, nameservers, lock, renewal and WHOIS contacts for an account domain. |

### `godaddySearchDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name to check (e.g. "example.com") |

### `godaddyRegisterDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name to register (e.g. "example.com") |
| `period` | number | No | Registration period in years (default: 1) |
| `autoRenew` | boolean | No | Enable automatic renewal (default: true) |
| `privacy` | boolean | No | Enable WHOIS privacy protection (default: false) |
| `contactRegistrant` | object | Yes | Registrant contact information (`nameFirst`, `nameLast`, `email`, `phone`, `organization`, `addressMailing`) |
| `contactRegistrant.nameFirst` | string | Yes, within `contactRegistrant` | First name |
| `contactRegistrant.nameLast` | string | Yes, within `contactRegistrant` | Last name |
| `contactRegistrant.email` | string | Yes, within `contactRegistrant` | Email address |
| `contactRegistrant.phone` | string | Yes, within `contactRegistrant` | Phone number (e.g. "+1.5551234567") |
| `contactRegistrant.organization` | string | No | Organization name (optional) |
| `contactRegistrant.addressMailing` | object | No | Mailing address |
| `contactRegistrant.addressMailing.address1` | string | Yes, within `addressMailing` | Street address line 1 |
| `contactRegistrant.addressMailing.address2` | string | No | Street address line 2 (optional) |
| `contactRegistrant.addressMailing.city` | string | Yes, within `addressMailing` | City |
| `contactRegistrant.addressMailing.state` | string | Yes, within `addressMailing` | State/province code |
| `contactRegistrant.addressMailing.postalCode` | string | Yes, within `addressMailing` | Postal/zip code |
| `contactRegistrant.addressMailing.country` | string | Yes, within `addressMailing` | Country code (e.g. "US") |
| `contactAdmin` | object | No | Admin contact (defaults to registrant if omitted) |
| `contactTech` | object | No | Tech contact (defaults to registrant if omitted) |
| `nameServers` | array of strings | No | Custom nameservers (optional, uses GoDaddy defaults if omitted) |

### `godaddyListDomains`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | No | Maximum number of domains to return (default: 100, max: 1000) |
| `marker` | string | No | Marker domain for pagination (return domains after this one) |

### `godaddyConfigureDns`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name (e.g. "example.com") |
| `action` | string, enum: `add`, `remove`, `list`, `update` | Yes | Action to perform on DNS records |
| `type` | string, enum: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `SRV`, `CAA` | No | DNS record type (required for add/remove/update; optional filter for list) |
| `name` | string | No | DNS record name / host (e.g. "@" for root, "www", "mail"). Required for remove and update. |
| `records` | array of objects | No | DNS records to add or set (for add and update actions) |
| `records[].type` | string | No | Record type (required for add, derived from parent type for update) |
| `records[].name` | string | No | Record name/host (required for add, derived from parent name for update) |
| `records[].data` | string | Yes, within each record | Record value / data (e.g. IP address, hostname) |
| `records[].ttl` | number | No | Time to live in seconds (default: 3600) |
| `records[].priority` | number | No | Priority (for MX and SRV records) |
| `records[].port` | number | No | Port (for SRV records) |
| `records[].weight` | number | No | Weight (for SRV records) |

### `godaddyGetDomainInfo`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | The domain name to look up (e.g. "example.com") |

## Notes

Activation rejects missing credentials and checks authentication by listing domains. API keys come from `https://developer.godaddy.com/keys`.

Registration charges the account. The purchase request supplies `DNRA` consent with the registrant email and the request timestamp. Admin and technical contacts default to the registrant.

DNS additions append records. Updates replace all records matching the selected type and name; removals delete all matching records. Additions default missing record types to `A` and missing names to `@`. Removal and update require `type` and `name`; addition and update require a nonempty `records` array. The listing tool forwards `limit` without enforcing the schema description's maximum. Tool failures return `success: false` and an `error` message.

## License

Apache-2.0
