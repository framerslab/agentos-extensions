// @ts-nocheck
/**
 * @fileoverview Agent Personal Wallet Extension Pack.
 *
 * Provides autonomous crypto spending tools with configurable guardrails:
 * - check_wallet_balance — query balances across Solana/EVM chains
 * - send_crypto — send with spending policy enforcement
 * - wallet_transaction_history — view recent transactions
 *
 * @module @framers/agentos-ext-wallet
 */

import { AgentWalletManager } from './AgentWalletManager.js';
import { SpendingPolicyEnforcer } from './SpendingPolicyEnforcer.js';
import { SolanaWalletAdapter } from './chains/SolanaWalletAdapter.js';
import { EvmWalletAdapter } from './chains/EvmWalletAdapter.js';
import { createCheckBalanceTool } from './tools/CheckBalanceTool.js';
import { createSendCryptoTool } from './tools/SendCryptoTool.js';
import { createWalletHistoryTool } from './tools/WalletHistoryTool.js';
import { createIssueCardTool } from './tools/IssueCardTool.js';
import { createCardStatusTool } from './tools/CardStatusTool.js';
import { createFreezeCardTool } from './tools/FreezeCardTool.js';
import { createUnfreezeCardTool } from './tools/UnfreezeCardTool.js';
import { createCardSpendingSummaryTool } from './tools/CardSpendingSummaryTool.js';
import { createPayWithCardTool } from './tools/PayWithCardTool.js';
import { CardManager } from './cards/CardManager.js';
import { LithicCardAdapter } from './cards/LithicCardAdapter.js';
import { MccCategoryMap } from './cards/MccCategoryMap.js';
import { DEFAULT_SPENDING_POLICY } from './types.js';
import type { ChainId, WalletConfig } from './types.js';
import type { CardConfig, ICardStore, AgentCardRecord, CardTransactionRecord, CardState, CardTxStatus } from './cards/types.js';
import { PACKAGE_VERSION } from './packageVersion.js';

/* ------------------------------------------------------------------ */
/*  Extension pack types                                               */
/* ------------------------------------------------------------------ */

export interface ExtensionContext {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
  getSecret?: (key: string) => string | undefined;
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void };
}

export interface ExtensionPack {
  name: string;
  version: string;
  descriptors: Array<{
    id: string;
    kind: string;
    priority?: number;
    payload: unknown;
  }>;
  onActivate?: () => Promise<void>;
  onDeactivate?: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  In-memory stores (CLI/ephemeral — production would use DB)         */
/* ------------------------------------------------------------------ */

function createMemoryLedgerStore() {
  const data: Array<{ agentId: string; category: string; amountUsd: number; periodKey: string }> = [];
  return {
    async sumByPeriod(agentId: string, periodKey: string) {
      return data.filter(e => e.agentId === agentId && e.periodKey === periodKey)
        .reduce((sum, e) => sum + e.amountUsd, 0);
    },
    async sumByCategoryAndPeriod(agentId: string, category: string, periodKey: string) {
      return data.filter(e => e.agentId === agentId && e.category === category && e.periodKey === periodKey)
        .reduce((sum, e) => sum + e.amountUsd, 0);
    },
    async insert(entry: any) { data.push(entry); },
  };
}

function createMemoryWalletStore() {
  const walletRecords = new Map<string, any>();
  const txRecords = new Map<string, any[]>();
  return {
    async getWallet(agentId: string, chain: string) {
      return walletRecords.get(`${agentId}:${chain}`) || null;
    },
    async getAllWallets(agentId: string) {
      return [...walletRecords.values()].filter((w: any) => w.agentId === agentId);
    },
    async saveWallet(record: any) {
      walletRecords.set(`${record.agentId}:${record.chain}`, record);
    },
    async insertTransaction(record: any) {
      const list = txRecords.get(record.walletId) || [];
      list.push(record);
      txRecords.set(record.walletId, list);
    },
    async updateTransactionStatus(id: string, status: string, txHash?: string) {
      for (const [, list] of txRecords) {
        const tx = list.find((t: any) => t.id === id);
        if (tx) { tx.status = status; if (txHash) tx.txHash = txHash; return; }
      }
    },
    async getTransactions(walletId: string, limit = 20) {
      return (txRecords.get(walletId) || []).slice(-limit).reverse();
    },
  };
}

function createMemoryCardStore(): ICardStore {
  const cards = new Map<string, AgentCardRecord>();
  const txRecords = new Map<string, CardTransactionRecord[]>();
  return {
    async getCard(agentId: string) {
      return [...cards.values()].find(c => c.agentId === agentId) || null;
    },
    async saveCard(record: AgentCardRecord) {
      cards.set(record.id, record);
    },
    async updateCardState(agentId: string, state: CardState) {
      for (const card of cards.values()) {
        if (card.agentId === agentId) { card.state = state; return; }
      }
    },
    async insertTransaction(record: CardTransactionRecord) {
      const list = txRecords.get(record.cardId) || [];
      list.push(record);
      txRecords.set(record.cardId, list);
    },
    async updateTransactionStatus(id: string, status: CardTxStatus) {
      for (const [, list] of txRecords) {
        const tx = list.find(t => t.id === id);
        if (tx) { tx.status = status; return; }
      }
    },
    async getTransactions(cardId: string, limit = 20) {
      return (txRecords.get(cardId) || []).slice(-limit).reverse();
    },
    async getTransactionsByPeriod(cardId: string, since: number) {
      return (txRecords.get(cardId) || []).filter(t => t.createdAt >= since);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createExtensionPack(context: ExtensionContext): ExtensionPack {
  const opts = (context.options || {}) as Partial<WalletConfig>;
  const walletConfig: WalletConfig = {
    enabled: opts.enabled ?? true,
    chains: opts.chains || ['solana'],
    custodyMode: opts.custodyMode || 'encrypted-hot',
    allowedTokens: opts.allowedTokens || ['SOL', 'USDC'],
    spendingPolicy: opts.spendingPolicy || DEFAULT_SPENDING_POLICY,
    card: (opts as any).card,
  };

  // Build chain adapters
  const adapters = new Map<ChainId, any>();
  for (const chain of walletConfig.chains) {
    if (chain === 'solana') adapters.set('solana', new SolanaWalletAdapter());
    else adapters.set(chain, new EvmWalletAdapter({ chain }));
  }

  const masterSecret =
    context.getSecret?.('WALLET_MASTER_SECRET')
    || context.secrets?.['WALLET_MASTER_SECRET']
    || process.env['WALLET_MASTER_SECRET']
    || 'dev-secret-change-me';

  const policyEnforcer = new SpendingPolicyEnforcer(walletConfig.spendingPolicy, createMemoryLedgerStore());

  const walletManager = new AgentWalletManager({
    masterSecret,
    walletConfig,
    store: createMemoryWalletStore(),
    policyEnforcer,
    adapters,
  });

  const checkBalance = createCheckBalanceTool(walletManager);
  const sendCrypto = createSendCryptoTool(walletManager);
  const walletHistory = createWalletHistoryTool(walletManager);

  const descriptors: ExtensionPack['descriptors'] = [
    { id: checkBalance.name, kind: 'tool' as const, priority: 50, payload: checkBalance },
    { id: sendCrypto.name, kind: 'tool' as const, priority: 50, payload: sendCrypto },
    { id: walletHistory.name, kind: 'tool' as const, priority: 50, payload: walletHistory },
  ];

  // Card tools (Lithic) — only if card config is enabled
  let cardManager: CardManager | undefined;
  const cardConfig = walletConfig.card;
  if (cardConfig?.enabled) {
    const lithicApiKey =
      context.getSecret?.('LITHIC_API_KEY')
      || context.secrets?.['LITHIC_API_KEY']
      || process.env['LITHIC_API_KEY']
      || '';

    const lithicAdapter = new LithicCardAdapter({
      apiKey: lithicApiKey,
      sandbox: process.env['NODE_ENV'] !== 'production',
    });

    const mccMap = new MccCategoryMap();

    cardManager = new CardManager({
      adapter: lithicAdapter,
      store: createMemoryCardStore(),
      policyEnforcer,
      mccMap,
      config: cardConfig,
    });

    const issueCard = createIssueCardTool(cardManager);
    const cardStatus = createCardStatusTool(cardManager);
    const freezeCard = createFreezeCardTool(cardManager);
    const unfreezeCard = createUnfreezeCardTool(cardManager);
    const cardSpending = createCardSpendingSummaryTool(cardManager);
    const payWithCard = createPayWithCardTool(cardManager);

    descriptors.push(
      { id: issueCard.name, kind: 'tool' as const, priority: 50, payload: issueCard },
      { id: cardStatus.name, kind: 'tool' as const, priority: 50, payload: cardStatus },
      { id: freezeCard.name, kind: 'tool' as const, priority: 50, payload: freezeCard },
      { id: unfreezeCard.name, kind: 'tool' as const, priority: 50, payload: unfreezeCard },
      { id: cardSpending.name, kind: 'tool' as const, priority: 50, payload: cardSpending },
      { id: payWithCard.name, kind: 'tool' as const, priority: 50, payload: payWithCard },
    );
  }

  const features: string[] = [`chains: ${walletConfig.chains.join(', ')}`];
  if (cardConfig?.enabled) features.push('virtual card (Lithic)');

  return {
    name: '@framers/agentos-ext-wallet',
    version: PACKAGE_VERSION,
    descriptors,
    onActivate: async () => context.logger?.info(`Wallet extension activated (${features.join(', ')})`),
    onDeactivate: async () => context.logger?.info('Wallet extension deactivated'),
  };
}

/* ------------------------------------------------------------------ */
/*  Re-exports                                                         */
/* ------------------------------------------------------------------ */

// Core
export { AgentWalletManager, ApprovalRequiredError, SpendingPolicyViolation } from './AgentWalletManager.js';
export type { AgentWalletManagerOptions, IWalletStore } from './AgentWalletManager.js';
export { SpendingPolicyEnforcer } from './SpendingPolicyEnforcer.js';
export type { ISpendingLedgerStore } from './SpendingPolicyEnforcer.js';

// Types
export type {
  AgentWalletRecord,
  CategoryBudget,
  ChainId,
  IChainWalletAdapter,
  SpendCategory,
  SpendCheckResult,
  SpendingLedgerEntry,
  SpendingPolicyConfig,
  TokenInfo,
  TokenSymbol,
  WalletConfig,
  WalletDirection,
  WalletTransactionRecord,
  WalletTxStatus,
} from './types.js';
export { DEFAULT_SPENDING_POLICY, DEFAULT_WALLET_CONFIG } from './types.js';

// Chain adapters
export { SolanaWalletAdapter } from './chains/SolanaWalletAdapter.js';
export type { SolanaWalletAdapterOptions } from './chains/SolanaWalletAdapter.js';
export { EvmWalletAdapter, KNOWN_TOKENS } from './chains/EvmWalletAdapter.js';
export type { EvmWalletAdapterOptions } from './chains/EvmWalletAdapter.js';

// Tool factories — crypto
export { createCheckBalanceTool } from './tools/CheckBalanceTool.js';
export { createSendCryptoTool } from './tools/SendCryptoTool.js';
export { createWalletHistoryTool } from './tools/WalletHistoryTool.js';

// Tool factories — card
export { createIssueCardTool } from './tools/IssueCardTool.js';
export { createCardStatusTool } from './tools/CardStatusTool.js';
export { createFreezeCardTool } from './tools/FreezeCardTool.js';
export { createUnfreezeCardTool } from './tools/UnfreezeCardTool.js';
export { createCardSpendingSummaryTool } from './tools/CardSpendingSummaryTool.js';
export { createPayWithCardTool } from './tools/PayWithCardTool.js';

// Card subsystem
export { CardManager } from './cards/CardManager.js';
export type { CardManagerOptions } from './cards/CardManager.js';
export { CardSpendingBlockedError } from './cards/CardManager.js';
export { LithicCardAdapter, LithicApiError } from './cards/LithicCardAdapter.js';
export type { LithicCardAdapterOptions } from './cards/LithicCardAdapter.js';
export { MccCategoryMap } from './cards/MccCategoryMap.js';
export type {
  AgentCardRecord,
  CardConfig,
  CardTransactionRecord,
  CardTxStatus,
  CardState,
  CardType,
  CardNetwork,
  ICardAdapter,
  ICardStore,
  LithicCardResponse,
  LithicTransaction,
  SpendingSummary,
  SpendLimitDuration,
} from './cards/types.js';
export { DEFAULT_CARD_CONFIG } from './cards/types.js';

export default createExtensionPack;
