/**
 * @fileoverview The Slack connector under the shared account-source conformance cases, against the stand-in, once for
 * each channel set: its selection names channel-days, so it registers the exact item listing under the set, and it
 * refuses a selection of more than 100 channel-days. The cases register with `node:test`; this file mocks it with a
 * registry and runs each case inside a vitest case.
 */
import { describe, expect, it, vi } from 'vitest';
import { connectorConformance } from '../../../../../contracts/source-connectors/conformance.js';
import type { SlackSelectionMode } from '../src/index.js';
import { day, tsAt } from './standin.js';
import { connectedAt, openSlack } from './fixture.js';

const registry = vi.hoisted(() => {
  const cases: Array<{ name: string; work: () => Promise<void> }> = [];
  return { cases, test: (name: string, _options: unknown, work: () => Promise<void>) => { cases.push({ name, work }); } };
});
vi.mock('node:test', () => ({ test: registry.test }));

/** The channel each set reads a day of. */
const present: Record<SlackSelectionMode, string> = { invited: 'G0SECRET', public: 'C0RANDOM', all: 'G0SECRET' };

describe('the account-source conformance cases', () => {
  for (const mode of ['invited', 'public', 'all'] as const) {
    it(`passes every case under the ${mode} channel set`, async () => {
      const from = registry.cases.length;
      connectorConformance({
        name: `Slack (${mode})`, policy: { selectsItems: true, limitsSelection: true },
        async open() {
          const f = await openSlack();
          f.standin.people.set('U0ADA', { name: 'Ada', email: null });
          const message = [{ ts: tsAt(connectedAt + day + 3_600_000), user: 'U0ADA', text: 'Budget is final' }];
          f.standin.channel({ id: 'C0RANDOM', name: 'random', messages: message });
          f.standin.channel({ id: 'G0SECRET', name: 'secret', is_private: true, messages: message });
          const connector = f.connector({ mode });
          const id = `${present[mode]}:2026-11-03`;
          return {
            connector, selection: { ids: [id], mode }, present: id, removed: 'C0MISSING:2026-11-03', mode,
            cursor: '1793000000.000000',
            oversized: Array.from({ length: 101 }, (_, n) => `C0GENERAL:2026-${String(1 + (n % 12)).padStart(2, '0')}-${String(1 + Math.floor(n / 12)).padStart(2, '0')}`),
            requests: () => f.standin.trace.length,
            failChanges: () => f.standin.failNext('conversations.history', { status: 503, body: { ok: false, error: 'service_unavailable' } }),
            close: () => f.close(),
          };
        },
      });
      const outcomes = new Map<string, string>();
      for (const registered of registry.cases.slice(from)) {
        try { await registered.work(); outcomes.set(registered.name, 'passed'); }
        catch (error) { outcomes.set(registered.name, error instanceof Error ? error.message : String(error)); }
      }
      expect(outcomes.size).toBe(8);
      expect(Object.fromEntries(outcomes)).toEqual(Object.fromEntries([...outcomes.keys()].map((name) => [name, 'passed'])));
    });
  }
});
