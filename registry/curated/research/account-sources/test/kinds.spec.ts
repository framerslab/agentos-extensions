import { describe, expect, it, vi } from 'vitest';
import * as accountSources from '../src/index.js';
import type { AccountSourceConnector, SourceItem, SourceSelection } from '../src/types.js';
import { runConformance } from './conformanceCases.js';

const registry = vi.hoisted(() => {
  const cases: Array<{ name: string; work: () => Promise<void> }> = [];
  return { cases, test: (name: string, _options: unknown, work: () => Promise<void>) => { cases.push({ name, work }); } };
});
vi.mock('node:test', () => ({ test: registry.test }));

describe('the connection kinds', () => {
  it('names notion and slack beside the kinds the published connectors read', () => {
    expect(accountSources.ACCOUNT_SOURCE_KINDS).toEqual(
      ['upload', 'web', 'dropbox', 'google_drive', 'github', 'gmail', 'notion', 'slack']);
    expect(Object.isFrozen(accountSources.ACCOUNT_SOURCE_KINDS)).toBe(true);
  });

  it('tells a named kind from a later connector\'s', () => {
    expect(accountSources.isAccountSourceKind('notion')).toBe(true);
    expect(accountSources.isAccountSourceKind('slack')).toBe(true);
    expect(accountSources.isAccountSourceKind('gmail')).toBe(true);
    expect(accountSources.isAccountSourceKind('linear')).toBe(false);
    expect(accountSources.isAccountSourceKind('Slack')).toBe(false);
  });
});

/**
 * A write-only connector, as Notion's connection is: it writes pages the person chose and reads none, so it lists
 * nothing, reads nothing and reports no change, and none of those reaches the provider.
 */
function writeOnly(counter: { requests: number }): AccountSourceConnector {
  const refuse = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('aborted'); };
  return {
    kind: 'notion',
    async list(_selection: SourceSelection, signal?: AbortSignal) { refuse(signal); return { items: [], gone: [] }; },
    async read(item: SourceItem, signal?: AbortSignal) { refuse(signal); return { id: item.id, reason: 'no_access' as const }; },
    async changesSince(cursor: string | null, _selection: SourceSelection, signal?: AbortSignal) {
      refuse(signal); return { changed: [], gone: [], cursor: cursor ?? 'notion-none' };
    },
    async revoke() { counter.requests++; },
  };
}

describe('a write-only connector in the conformance suite', () => {
  const subject = (policy: { writeOnly?: boolean; selectsItems?: boolean }) => ({
    name: 'Write-only fixture', policy,
    async open() {
      const counter = { requests: 0 };
      return { connector: writeOnly(counter), selection: { ids: ['page-1'] }, present: 'page-1', removed: 'page-404',
        cursor: 'notion-none', requests: () => counter.requests, failChanges: () => {}, close: async () => {} };
    },
  });

  it('passes every case its policy registers, the exact item listing with an empty listing among them', async () => {
    const outcomes = await runConformance(registry, subject({ writeOnly: true, selectsItems: true }));
    expect(outcomes.get('a selection of items lists exactly the held ones and names the others removed')).toEqual({ passed: true });
    expect(outcomes.get('a write-only connector lists, reads and reports nothing, and reaches no provider')).toEqual({ passed: true });
    expect(outcomes.has('a read keeps its item, names its connector, dates itself and answers text or bytes')).toBe(false);
    expect(outcomes.has('a read of an item the provider no longer holds answers it removed')).toBe(false);
    expect(outcomes.has('a failed change request answers no cursor')).toBe(false);
    expect([...outcomes.entries()].filter(([, outcome]) => !outcome.passed)).toEqual([]);
  });

  it('fails the read cases when the subject does not declare it write-only', async () => {
    const outcomes = await runConformance(registry, subject({ selectsItems: true }));
    expect(outcomes.get('a read keeps its item, names its connector, dates itself and answers text or bytes')?.passed).toBe(false);
  });
});
