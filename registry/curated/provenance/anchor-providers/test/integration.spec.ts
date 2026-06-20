// @ts-nocheck
/**
 * @file integration.spec.ts
 * @description End-to-end integration tests verifying that the extension's
 * registerExtensionProviders() correctly hooks into the core
 * createAnchorProvider() factory for all provider types.
 *
 * Uses vi.resetModules() + dynamic import to get a fresh register.ts module
 * per test (bypassing the idempotent `registered` flag).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnchorRecord } from '@framers/agentos';

// Use vi.hoisted() so the mock fn is available before vi.mock hoisting
const { mockRegister, factories } = vi.hoisted(() => {
  const factories = new Map<string, (opts: any) => any>();
  const mockRegister = vi.fn((type: string, factory: (opts: any) => any) => {
    factories.set(type, factory);
  });
  return { mockRegister, factories };
});

vi.mock('@framers/agentos', () => ({
  registerAnchorProviderFactory: mockRegister,
}));

function createMockAnchor(): AnchorRecord {
  return {
    id: 'anchor-int-001',
    merkleRoot: 'abc123',
    sequenceFrom: 1,
    sequenceTo: 5,
    eventCount: 5,
    timestamp: '2025-01-15T00:00:00.000Z',
    signature: 'sig-base64',
  };
}

async function freshRegister(): Promise<void> {
  // Reset module cache so register.ts `registered` flag starts false
  vi.resetModules();
  // Re-mock since resetModules clears mocks too
  vi.doMock('@framers/agentos', () => ({
    registerAnchorProviderFactory: mockRegister,
  }));
  const mod = await import('../src/register.js');
  mod.registerExtensionProviders();
}

describe('Extension ↔ Core Integration', () => {
  beforeEach(async () => {
    mockRegister.mockClear();
    factories.clear();
    await freshRegister();
  });

  it('should register all 5 provider types with the core factory', () => {
    expect(factories.has('worm-snapshot')).toBe(true);
    expect(factories.has('rekor')).toBe(true);
    expect(factories.has('opentimestamps')).toBe(true);
    expect(factories.has('ethereum')).toBe(true);
    expect(factories.has('solana')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Factory-created provider identity
  // ---------------------------------------------------------------------------

  it('worm-snapshot factory should create correct provider', async () => {
    const { WormSnapshotProvider } = await import('../src/providers/WormSnapshotProvider.js');
    const factory = factories.get('worm-snapshot')!;
    const provider = factory({ bucket: 'test-bucket', region: 'us-east-1' });
    expect(provider).toBeInstanceOf(WormSnapshotProvider);
    expect(provider.id).toBe('worm-snapshot');
    expect(provider.proofLevel).toBe('externally-archived');
  });

  it('rekor factory should create RekorProvider with custom server', async () => {
    const { RekorProvider } = await import('../src/providers/RekorProvider.js');
    const factory = factories.get('rekor')!;
    const provider = factory({ serverUrl: 'https://custom.rekor.dev' });
    expect(provider).toBeInstanceOf(RekorProvider);
    expect(provider.id).toBe('rekor');
    expect(provider.proofLevel).toBe('publicly-auditable');
  });

  it('opentimestamps factory should create OpenTimestampsProvider', async () => {
    const { OpenTimestampsProvider } = await import('../src/providers/OpenTimestampsProvider.js');
    const factory = factories.get('opentimestamps')!;
    const provider = factory({});
    expect(provider).toBeInstanceOf(OpenTimestampsProvider);
    expect(provider.id).toBe('opentimestamps');
    expect(provider.proofLevel).toBe('publicly-timestamped');
  });

  it('ethereum factory should create EthereumProvider with chain ID', async () => {
    const { EthereumProvider } = await import('../src/providers/EthereumProvider.js');
    const factory = factories.get('ethereum')!;
    const provider = factory({ rpcUrl: 'https://eth.test', chainId: 11155111 });
    expect(provider).toBeInstanceOf(EthereumProvider);
    expect(provider.id).toBe('ethereum');
    expect(provider.proofLevel).toBe('publicly-timestamped');
  });

  it('solana factory should create SolanaProvider', async () => {
    const { SolanaProvider } = await import('../src/providers/SolanaProvider.js');
    const factory = factories.get('solana')!;
    const provider = factory({ rpcUrl: 'https://solana.test', programId: '11111111111111111111111111111111' });
    expect(provider).toBeInstanceOf(SolanaProvider);
    expect(provider.id).toBe('solana');
    expect(provider.proofLevel).toBe('publicly-timestamped');
  });

  // ---------------------------------------------------------------------------
  // Factory-created providers behavior (stubs)
  // ---------------------------------------------------------------------------

  it('all factory-created providers should return failure from publish() without proper config', async () => {
    // After df7f670 these providers now ship REAL implementations (not
    // stubs), so the error messages reflect what each backend reports
    // when the SDK can't connect with default config:
    //   - worm-snapshot: AWS SDK "Could not load credentials..." OR a
    //     network-stage S3 failure (the env may or may not have IMDS).
    //   - opentimestamps / ethereum: HTTP call to the fake URL
    //     fails (fetch error, ENOTFOUND, getaddrinfo, etc.).
    //   - rekor: publish() requires publicKeyPem + signArtifact, so with
    //     an empty config it returns its config-precondition error before
    //     any network call (deterministic, regardless of connectivity).
    //   - solana: still stubbed via the missing-signer guard.
    //
    // The regex accepts the legacy "not yet implemented" stub message
    // too so the test stays valid if a provider gets reverted to a stub.
    const anchor = createMockAnchor();

    const ANY_RUNTIME_FAILURE = /not yet implemented|s3|credentials|fetch failed|enotfound|getaddrinfo|connect|timeout|invalid|failed/i;

    const configs: [string, Record<string, unknown>, RegExp][] = [
      ['worm-snapshot', { bucket: 'b', region: 'us-east-1' }, ANY_RUNTIME_FAILURE],
      ['rekor', {}, /requires both publicKeyPem|not yet implemented/i],
      ['opentimestamps', {}, ANY_RUNTIME_FAILURE],
      // No signerPrivateKey -> EthereumProvider returns its config-precondition
      // error ("requires signerPrivateKey ...") before any RPC call, so match
      // that (with network-failure fallbacks) rather than ANY_RUNTIME_FAILURE.
      ['ethereum', { rpcUrl: 'https://eth.test' }, /requires signerPrivateKey|fetch failed|enotfound|getaddrinfo|connect|timeout|failed/i],
      ['solana', { rpcUrl: 'https://solana.test', programId: '11111111111111111111111111111111' }, /missing signer configuration/i],
    ];

    // OpenTimestamps anchors against free public calendar servers and
    // worm-snapshot writes to S3 — both can legitimately SUCCEED when the CI
    // runner has network / ambient credentials, which is correct behavior, not a
    // failure. Tolerate their success so the test is deterministic instead of
    // flaking on network state, while still requiring every config-gated provider
    // (rekor needs a signing key, solana a signer, ethereum a real RPC) to fail
    // gracefully with a recognizable error.
    const maySucceedWithoutConfig = new Set(['opentimestamps', 'worm-snapshot']);
    for (const [type, opts, expectedError] of configs) {
      const factory = factories.get(type)!;
      const provider = factory(opts);
      const result = await provider.publish(anchor);
      expect(result.providerId).toBe(type);
      if (maySucceedWithoutConfig.has(type) && result.success) continue;
      expect(result.success).toBe(false);
      expect(result.error).toMatch(expectedError);
    }
  });

  it('all factory-created providers should return false from verify()', async () => {
    const anchor = createMockAnchor();

    const configs: [string, Record<string, unknown>][] = [
      ['worm-snapshot', { bucket: 'b', region: 'us-east-1' }],
      ['rekor', {}],
      ['opentimestamps', {}],
      ['ethereum', { rpcUrl: 'https://eth.test' }],
      ['solana', { rpcUrl: 'https://solana.test', programId: '11111111111111111111111111111111' }],
    ];

    for (const [type, opts] of configs) {
      const factory = factories.get(type)!;
      const provider = factory(opts);
      const valid = await provider.verify(anchor);
      expect(valid).toBe(false);
    }
  });

  // ---------------------------------------------------------------------------
  // Default config values
  // ---------------------------------------------------------------------------

  it('rekor factory should use default server URL when not provided', async () => {
    const { RekorProvider } = await import('../src/providers/RekorProvider.js');
    const factory = factories.get('rekor')!;
    const provider = factory(undefined);
    expect(provider).toBeInstanceOf(RekorProvider);
  });

  it('worm-snapshot factory should apply default retention config', () => {
    const factory = factories.get('worm-snapshot')!;
    const provider = factory({ bucket: 'b', region: 'r' });
    expect(provider.id).toBe('worm-snapshot');
    expect(provider.name).toBe('WORM Snapshot (S3 Object Lock)');
  });
});
