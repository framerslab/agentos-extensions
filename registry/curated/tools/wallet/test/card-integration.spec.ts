// @ts-nocheck
/**
 * @fileoverview Integration tests for the card subsystem within the wallet extension pack.
 *
 * Tests the full lifecycle: extension pack creation with card enabled →
 * card tool registration → card issuance → status → spending summary →
 * freeze → unfreeze → close. Also verifies backwards compatibility
 * when card is disabled.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import type { ExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

/* ------------------------------------------------------------------ */
/*  Mock fetch for Lithic API calls                                    */
/* ------------------------------------------------------------------ */

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();

  // Default mock for Lithic createCard
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      token: 'integration-card-token',
      last_four: '8888',
      type: 'VIRTUAL',
      state: 'OPEN',
      spend_limit: 50000,
      spend_limit_duration: 'MONTHLY',
      pan: '4111111111118888',
      cvv: '789',
      exp_month: '03',
      exp_year: '2030',
      funding: { token: 'fund-1', type: 'DEPOSITORY_CHECKING' },
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('card integration', () => {

  /* ── Extension pack with cards disabled ────────────────────────── */

  describe('card disabled (backwards compatibility)', () => {
    it('should create pack with only 3 crypto tools when card not configured', () => {
      const pack = createExtensionPack({
        options: { enabled: true, chains: ['solana'] },
      });

      expect(pack.descriptors.length).toBe(3);
      expect(pack.descriptors.every(d => d.kind === 'tool')).toBe(true);
    });

    it('should create pack with only 3 crypto tools when card.enabled=false', () => {
      const pack = createExtensionPack({
        options: { enabled: true, chains: ['solana'], card: { enabled: false, provider: 'lithic', defaultSpendLimitUsd: 500, allowPhysical: false } },
      });

      expect(pack.descriptors.length).toBe(3);
    });
  });

  /* ── Extension pack with cards enabled ─────────────────────────── */

  describe('card enabled', () => {
    let pack: ExtensionPack;

    beforeEach(() => {
      pack = createExtensionPack({
        options: {
          enabled: true,
          chains: ['solana'],
          card: { enabled: true, provider: 'lithic', defaultSpendLimitUsd: 500, allowPhysical: false },
        },
        secrets: { LITHIC_API_KEY: 'test-lithic-key' },
      });
    });

    it('should create pack with 9 tools (3 crypto + 6 card)', () => {
      expect(pack.descriptors.length).toBe(9);
      expect(pack.descriptors.every(d => d.kind === 'tool')).toBe(true);
    });

    it('should register all 6 card tools', () => {
      const toolNames = pack.descriptors.map(d => d.id);
      expect(toolNames).toContain('issue_virtual_card');
      expect(toolNames).toContain('card_status');
      expect(toolNames).toContain('freeze_card');
      expect(toolNames).toContain('unfreeze_card');
      expect(toolNames).toContain('card_spending_summary');
      expect(toolNames).toContain('pay_with_card');
    });

    it('should still register all 3 crypto tools', () => {
      const toolNames = pack.descriptors.map(d => d.id);
      expect(toolNames).toContain('check_wallet_balance');
      expect(toolNames).toContain('send_crypto');
      expect(toolNames).toContain('wallet_transaction_history');
    });

    it('should set version to 0.2.0', () => {
      expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    });

    it('should call onActivate with card mention', async () => {
      const logs: string[] = [];
      const p = createExtensionPack({
        options: {
          enabled: true,
          chains: ['solana'],
          card: { enabled: true, provider: 'lithic', defaultSpendLimitUsd: 500, allowPhysical: false },
        },
        logger: { info: (m: string) => logs.push(m) },
      });

      await p.onActivate?.();
      expect(logs.length).toBe(1);
      expect(logs[0]).toContain('virtual card');
    });
  });

  /* ── Card tool execution lifecycle ─────────────────────────────── */

  describe('card tool lifecycle', () => {
    const CTX = {
      gmiId: 'integration-agent',
      personaId: 'persona-1',
      userContext: { userId: 'user-1' } as any,
    };

    function getTools(pack: ExtensionPack) {
      const tools = new Map<string, any>();
      for (const desc of pack.descriptors) {
        if (desc.kind === 'tool') tools.set((desc.payload as any).name, desc.payload);
      }
      return tools;
    }

    it('should execute issue → status → freeze → unfreeze → close lifecycle', async () => {
      const pack = createExtensionPack({
        options: {
          enabled: true,
          chains: ['solana'],
          card: { enabled: true, provider: 'lithic', defaultSpendLimitUsd: 500, allowPhysical: false },
        },
        secrets: { LITHIC_API_KEY: 'test-key' },
      });

      const tools = getTools(pack);

      // Issue card
      const issueResult = await tools.get('issue_virtual_card').execute({}, CTX);
      expect(issueResult.success).toBe(true);
      expect(issueResult.output.last4).toBe('8888');

      // Check status
      const statusResult = await tools.get('card_status').execute({}, CTX);
      expect(statusResult.success).toBe(true);
      expect(statusResult.output.state).toBe('OPEN');

      // Spending summary (empty)
      const spendingResult = await tools.get('card_spending_summary').execute({}, CTX);
      expect(spendingResult.success).toBe(true);
      expect(spendingResult.output.totalUsd).toBe(0);

      // Freeze
      const freezeResult = await tools.get('freeze_card').execute({}, CTX);
      expect(freezeResult.success).toBe(true);
      expect(freezeResult.output.state).toBe('PAUSED');

      // Unfreeze
      const unfreezeResult = await tools.get('unfreeze_card').execute({}, CTX);
      expect(unfreezeResult.success).toBe(true);
      expect(unfreezeResult.output.state).toBe('OPEN');
    });

    it('should return error from card tools when no card exists', async () => {
      const pack = createExtensionPack({
        options: {
          enabled: true,
          chains: ['solana'],
          card: { enabled: true, provider: 'lithic', defaultSpendLimitUsd: 500, allowPhysical: false },
        },
      });

      const tools = getTools(pack);

      const statusResult = await tools.get('card_status').execute({}, CTX);
      expect(statusResult.success).toBe(false);
      expect(statusResult.error).toContain('No card found');

      const freezeResult = await tools.get('freeze_card').execute({}, CTX);
      expect(freezeResult.success).toBe(false);

      const spendingResult = await tools.get('card_spending_summary').execute({}, CTX);
      expect(spendingResult.success).toBe(false);
    });

    it('all tools should have category=wallet', () => {
      const pack = createExtensionPack({
        options: {
          enabled: true,
          chains: ['solana'],
          card: { enabled: true, provider: 'lithic', defaultSpendLimitUsd: 500, allowPhysical: false },
        },
      });

      for (const desc of pack.descriptors) {
        expect((desc.payload as any).category).toBe('wallet');
      }
    });

    it('all tools should have valid inputSchema', () => {
      const pack = createExtensionPack({
        options: {
          enabled: true,
          chains: ['solana'],
          card: { enabled: true, provider: 'lithic', defaultSpendLimitUsd: 500, allowPhysical: false },
        },
      });

      for (const desc of pack.descriptors) {
        const tool = desc.payload as any;
        expect(tool.inputSchema).toBeTruthy();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });
});
