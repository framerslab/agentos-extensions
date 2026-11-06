/**
 * @fileoverview The Slack coordinator's bounds: one provider call may take 90 seconds and a run 180 unless the host
 * names its own, and a bound the host leaves undefined keeps Slack's. The account-source coordinator is replaced by a
 * recorder of the options it is built with.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AccountSourceSyncOptions } from '@framers/agentos-ext-account-sources';
import { slackSourceSync } from '../src/index.js';
import { scope } from './fixture.js';

const built = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@framers/agentos-ext-account-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@framers/agentos-ext-account-sources')>();
  return { ...actual, AccountSourceSync: vi.fn(function record(options: Record<string, unknown>) { built.push(options); }) };
});

/** The coordinator's options a host may name, the store and the rest left to the recorder. */
const coordinator = (change: Record<string, unknown>) => change as unknown as Omit<AccountSourceSyncOptions<string>, 'provider'>;

describe("the Slack coordinator's bounds", () => {
  it("keeps Slack's 90-second call and 180-second run when the host names none or leaves them undefined, and takes the host's own", () => {
    const connector = async () => { throw new Error('unused'); };
    slackSourceSync<string>({ scope, coordinator: coordinator({}), connector });
    slackSourceSync<string>({ scope, coordinator: coordinator({ operationTimeoutMs: undefined, runBudgetMs: undefined }), connector });
    slackSourceSync<string>({ scope, coordinator: coordinator({ operationTimeoutMs: 60_000, runBudgetMs: 120_000 }), connector });
    expect(built.map((options) => [options.operationTimeoutMs, options.runBudgetMs]))
      .toEqual([[90_000, 180_000], [90_000, 180_000], [60_000, 120_000]]);
    expect(built.every((options) => typeof options.provider === 'function')).toBe(true);
  });
});
