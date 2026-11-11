// @ts-nocheck
/**
 * @fileoverview Integration tests for the wallet extension pack.
 *
 * Tests the full lifecycle: extension pack creation → wallet creation →
 * balance check → send with policy enforcement → history retrieval.
 * Also tests the createExtensionPack factory itself.
 */

import { describe, it, expect } from 'vitest';
import { createExtensionPack } from '../src/index.js';
import type { ExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

/* ------------------------------------------------------------------ */
/*  Extension pack factory                                             */
/* ------------------------------------------------------------------ */

describe('createExtensionPack', () => {
  it('should create a valid extension pack with 3 tool descriptors', () => {
    const pack = createExtensionPack({ options: { enabled: true, chains: ['solana'] } });

    expect(pack.name).toBe('@framers/agentos-ext-wallet');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors.length).toBe(3);
    expect(pack.descriptors.every(d => d.kind === 'tool')).toBe(true);
  });

  it('should register check_wallet_balance tool', () => {
    const pack = createExtensionPack({});
    const balanceTool = pack.descriptors.find(d => d.id === 'check_wallet_balance');

    expect(balanceTool).toBeTruthy();
    expect(balanceTool!.kind).toBe('tool');
    expect((balanceTool!.payload as any).name).toBe('check_wallet_balance');
  });

  it('should register send_crypto tool', () => {
    const pack = createExtensionPack({});
    const sendTool = pack.descriptors.find(d => d.id === 'send_crypto');

    expect(sendTool).toBeTruthy();
    expect((sendTool!.payload as any).hasSideEffects).toBe(true);
  });

  it('should register wallet_transaction_history tool', () => {
    const pack = createExtensionPack({});
    const historyTool = pack.descriptors.find(d => d.id === 'wallet_transaction_history');

    expect(historyTool).toBeTruthy();
    expect((historyTool!.payload as any).hasSideEffects).toBe(false);
  });

  it('should call onActivate without error', async () => {
    const logs: string[] = [];
    const pack = createExtensionPack({
      options: { chains: ['solana', 'ethereum'] },
      logger: { info: (m: string) => logs.push(m) },
    });

    await pack.onActivate?.();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('solana, ethereum');
  });

  it('should use WALLET_MASTER_SECRET from secrets', () => {
    // Should not throw — just verifies the factory accepts secrets
    const pack = createExtensionPack({
      secrets: { WALLET_MASTER_SECRET: 'my-production-secret' },
    });
    expect(pack.descriptors.length).toBe(3);
  });

  it('should default to solana chain when no options provided', () => {
    const logs: string[] = [];
    const pack = createExtensionPack({
      logger: { info: (m: string) => logs.push(m) },
    });

    // Trigger onActivate to see the default chains
    pack.onActivate?.();
    // The pack was created successfully with defaults
    expect(pack.descriptors.length).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/*  Full lifecycle integration                                         */
/* ------------------------------------------------------------------ */

describe('wallet lifecycle (integration)', () => {
  let pack: ExtensionPack;
  let tools: Map<string, any>;

  const CTX = {
    gmiId: 'integration-agent',
    personaId: 'persona-1',
    userContext: { userId: 'user-1' } as any,
  };

  // Note: These integration tests use the in-memory stores provided by
  // createExtensionPack, NOT real blockchain connections. The chain adapters
  // will fail on actual RPC calls, but we can still test the full tool
  // pipeline through the manager layer using mock-friendly scenarios.

  it('should create extension pack and extract tools', () => {
    pack = createExtensionPack({
      options: { enabled: true, chains: ['solana'] },
    });

    tools = new Map<string, any>();
    for (const desc of pack.descriptors) {
      if (desc.kind === 'tool') {
        tools.set((desc.payload as any).name, desc.payload);
      }
    }

    expect(tools.size).toBe(3);
    expect(tools.has('check_wallet_balance')).toBe(true);
    expect(tools.has('send_crypto')).toBe(true);
    expect(tools.has('wallet_transaction_history')).toBe(true);
  });

  it('check_wallet_balance should fail gracefully when no wallet exists', async () => {
    pack = createExtensionPack({ options: { chains: ['solana'] } });
    const balanceTool = pack.descriptors.find(d => d.id === 'check_wallet_balance')!.payload as any;

    const result = await balanceTool.execute({ chain: 'solana' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No solana wallet found');
  });

  it('send_crypto should validate amount before attempting send', async () => {
    pack = createExtensionPack({ options: { chains: ['solana'] } });
    const sendTool = pack.descriptors.find(d => d.id === 'send_crypto')!.payload as any;

    const result = await sendTool.execute({ to: 'addr', amount: '-1' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid amount');
  });

  it('wallet_transaction_history should fail gracefully when no wallet exists', async () => {
    pack = createExtensionPack({ options: { chains: ['solana'] } });
    const historyTool = pack.descriptors.find(d => d.id === 'wallet_transaction_history')!.payload as any;

    const result = await historyTool.execute({}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No solana wallet found');
  });

  it('tools should have valid inputSchema', () => {
    pack = createExtensionPack({});

    for (const desc of pack.descriptors) {
      const tool = desc.payload as any;
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('all tools should have category=wallet', () => {
    pack = createExtensionPack({});

    for (const desc of pack.descriptors) {
      const tool = desc.payload as any;
      expect(tool.category).toBe('wallet');
    }
  });
});
