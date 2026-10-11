# Wallet

This pack gives an agent wallet balance, crypto transfer and transaction history tools for Solana, Ethereum, Base and Polygon, plus optional virtual card tools for Lithic. Chain adapters use `@solana/web3.js`, `@solana/spl-token` and `ethers`, and the Lithic adapter uses REST requests through `fetch`.

## Installation

```bash
npm install @framers/agentos-ext-wallet
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`. Optional peers: `@solana/web3.js` with range `^1.0.0`, `@solana/spl-token` with range `^0.3.0`, and `ethers` with range `^6.0.0`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-wallet';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    chains: ['solana'],
    card: {
      enabled: true,
      defaultSpendLimitUsd: 500,
    },
  },
  secrets: {
    WALLET_MASTER_SECRET: process.env.WALLET_MASTER_SECRET!,
    LITHIC_API_KEY: process.env.LITHIC_API_KEY!,
  },
  logger: console,
}));
```

This registers crypto tools and enables the Lithic card tools. It does not create a wallet.

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `enabled` | None | None | No | `true`, copied into the wallet configuration |
| `chains` | None | None | No | `['solana']` |
| `custodyMode` | None | None | No | `encrypted-hot` |
| `allowedTokens` | None | None | No | `['SOL', 'USDC']` |
| `spendingPolicy` | None | None | No | `DEFAULT_SPENDING_POLICY` |
| `spendingPolicy.dailyLimitUsd` | None | None | Yes when supplying a custom policy | `50` USD in the default policy |
| `spendingPolicy.perTransactionLimitUsd` | None | None | Yes when supplying a custom policy | `20` USD in the default policy |
| `spendingPolicy.monthlyLimitUsd` | None | None | Yes when supplying a custom policy | `500` USD in the default policy |
| `spendingPolicy.categoryBudgets` | None | None | Yes when supplying a custom policy | `[]` in the default policy |
| `spendingPolicy.categoryBudgets[].category` | None | None | Yes for a category budget | No default |
| `spendingPolicy.categoryBudgets[].dailyLimitUsd` | None | None | Yes for a category budget | No default |
| `spendingPolicy.categoryBudgets[].monthlyLimitUsd` | None | None | Yes for a category budget | No default |
| `spendingPolicy.requireApprovalAboveUsd` | None | None | Yes when supplying a custom policy | `10` USD in the default policy |
| `spendingPolicy.blockedCategories` | None | None | Yes when supplying a custom policy | `[]` in the default policy |
| `spendingPolicy.allowedAddresses` | None | None | No | Unset |
| `spendingPolicy.blockedAddresses` | None | None | No | Unset |
| `card` | None | None | No | Unset, card tools are omitted |
| `card.enabled` | None | None | No | Unset, card tools are omitted |
| `card.defaultSpendLimitUsd` | None | None | Yes for a configured card limit | No factory default; `DEFAULT_CARD_CONFIG` specifies `500` USD |
| None | `WALLET_MASTER_SECRET` | `WALLET_MASTER_SECRET` | Yes, manifest | `dev-secret-change-me` in the factory |
| None | `LITHIC_API_KEY` | `LITHIC_API_KEY` | No, optional in manifest | Empty string |
| None | `LITHIC_WEBHOOK_SECRET` | None | No, optional in manifest | Not read by the implementation |
| None, Lithic environment | None | `NODE_ENV` | No | Sandbox unless the value is `production` |
| None, SOL reference USD price | None | `WALLET_PRICE_SOL_USD` | No | `1` USD |
| None, ETH reference USD price | None | `WALLET_PRICE_ETH_USD` | No | `1` USD |
| None, USDC reference USD price | None | `WALLET_PRICE_USDC_USD` | No | `1` USD |
| None, USDT reference USD price | None | `WALLET_PRICE_USDT_USD` | No | `1` USD |

Secrets resolve through `getSecret`, then `secrets`, then the corresponding environment variable. Missing master credentials use the factory's development secret despite the manifest requirement. Missing Lithic credentials leave an empty API authorization value; the factory does not reject them.

A supplied `spendingPolicy` replaces the default policy without merging fields. `card` is passed through without applying `DEFAULT_CARD_CONFIG`. Reference prices accept finite positive environment values and otherwise use the defaults above.

## Tools

| Tool | What it does |
| --- | --- |
| `check_wallet_balance` | Returns a wallet's blockchain balance in raw units and formatted token units. |
| `send_crypto` | Sends cryptocurrency to a destination address with spending policy checks. |
| `wallet_transaction_history` | Shows recent wallet transfers with amounts, status and categories. |
| `issue_virtual_card` | Issues a virtual debit card for online purchases, subscriptions and API payments. |
| `card_status` | Returns the virtual card's state, spending limit and card type. |
| `freeze_card` | Freezes the virtual card to pause transactions. |
| `unfreeze_card` | Resumes transaction processing for the virtual card. |
| `card_spending_summary` | Returns daily or monthly card spending grouped by category. |
| `pay_with_card` | Retrieves card number, CVV and expiry, with a spending policy check when an estimated amount is supplied. |

Card tools are registered only when `card.enabled` is truthy.

### `check_wallet_balance` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `chain` | `string`, enum: `solana`, `ethereum`, `base`, `polygon` | No | Blockchain to query. Defaults to `solana`. |
| `token` | `string`, enum: `SOL`, `ETH`, `USDC`, `USDT` | No | Token to check. Omit for native token (`SOL`/`ETH`). |

### `send_crypto` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | `string` | Yes | Destination wallet address. |
| `amount` | `string` | Yes | Amount to send in human-readable units (e.g. "0.5" for 0.5 SOL). |
| `chain` | `string`, enum: `solana`, `ethereum`, `base`, `polygon` | No | Blockchain to use. Defaults to `solana`. |
| `token` | `string`, enum: `SOL`, `ETH`, `USDC`, `USDT` | No | Token to send. Defaults to native token (`SOL`/`ETH`). |
| `category` | `string`, enum: `api_costs`, `web_services`, `shopping`, `subscriptions`, `transfers`, `defi`, `dining`, `travel`, `entertainment`, `utilities`, `other` | No | Spending category for budget tracking. Defaults to `transfers`. |
| `description` | `string` | No | Optional note for the transaction log. |

### `wallet_transaction_history` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `chain` | `string`, enum: `solana`, `ethereum`, `base`, `polygon` | No | Blockchain to query. Defaults to `solana`. |
| `limit` | `integer`, minimum `1`, maximum `50` | No | Max number of transactions to return. Defaults to `10`. |

### `issue_virtual_card` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `memo` | `string` | No | Optional label for the card (e.g. "API subscriptions"). |
| `spendLimitUsd` | `number` | No | Monthly spending limit in USD. Uses the default from config if omitted. |

### `card_status` parameters

The input schema is an empty object with no parameters.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |

### `freeze_card` parameters

The input schema is an empty object with no parameters.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |

### `unfreeze_card` parameters

The input schema is an empty object with no parameters.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |

### `card_spending_summary` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `period` | `string`, enum: `day`, `month` | No | Time period for the summary. Defaults to `month`. |

### `pay_with_card` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `estimatedAmountUsd` | `number` | No | Estimated transaction amount in USD for spending policy pre-check. |
| `category` | `string`, enum: `api_costs`, `web_services`, `shopping`, `subscriptions`, `transfers`, `defi`, `dining`, `travel`, `entertainment`, `utilities`, `other` | No | Spending category for budget tracking. Defaults to `shopping`. |
| `description` | `string` | No | What the payment is for (logged for audit trail). |

## Notes

The factory uses in-memory wallet, card and spending ledger stores. Records and budget totals do not persist across pack recreation. It creates no wallets and exposes no wallet creation tool or manager handle. Crypto tools fail when the agent has no wallet. The exported `AgentWalletManager` and tool factories support a separately constructed manager with caller-provided stores and adapters.

Tools identify the agent through `context.gmiId`. They declare `capability:wallet`; crypto sending also declares `capability:wallet_send`. Card tools declare `capability:wallet_card`, and payment detail retrieval also declares `capability:wallet_card_pay`.

`enabled`, `custodyMode` and `allowedTokens` are copied into configuration but do not gate registration or execution. Wallet creation encrypts private keys regardless of the custody mode. Chain adapters default to mainnet RPC endpoints and load their optional peers when needed. Missing peers return dependency errors. Balance results are cached for `30000` ms.

`send_crypto` signs and broadcasts native transfers, spends funds and records successful spending against the policy. It treats `SOL` as native on Solana and `ETH` as native on every EVM chain, including Polygon. It rejects `USDC` and `USDT` transfers despite their presence in the schema. Spending checks use configurable reference USD prices rather than a live price feed. Transactions above the approval threshold return an approval-required error before signing; the tool provides no approval continuation.

Lithic operations create virtual cards and change card state through API requests. Issuance rejects an existing card for the agent and sets a monthly provider spending limit. `card_status` reads the stored record. Issuance does not install blocked-category MCC rules because `getBlockedMccs` returns an empty array.

`pay_with_card` reveals sensitive card details and does not submit a payment. It checks policy only when `estimatedAmountUsd` is supplied and does not enforce the policy's approval flag. Its `description` parameter is not read during execution. Missing PAN data returns an error.

Card summaries use locally recorded pending and settled transactions. `CardManager.processWebhookTransaction` maps merchant category codes and records card spending, but the pack registers no webhook handler and does not read `LITHIC_WEBHOOK_SECRET`.

## License

Apache-2.0
