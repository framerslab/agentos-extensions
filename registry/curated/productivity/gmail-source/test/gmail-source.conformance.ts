/**
 * @fileoverview The installed Gmail connector under the shared account-source conformance cases, against the native
 * synthetic Gmail and OAuth server and disposable PostgreSQL tables. Its selection names threads and it refuses more
 * than the smaller of 100, the retained-document limit and the changed-per-lease limit, so it registers both policy
 * cases. Only the published-contract workflow compiles and runs it, in one directory with
 * `contracts/source-connectors/conformance.ts` and this folder's fixture.
 */
import { connectorConformance } from './conformance.js';
import { makeFixture } from './contract-fixture.js';
import { failure, paths } from './standin.js';

connectorConformance({
  name: 'Gmail',
  policy: { selectsItems: true, limitsSelection: true },
  async open() {
    const h = await makeFixture();
    try {
      const handle = await h.first.store.claim(h.scope, 'scheduled');
      if (!handle) throw new Error('fixture_lease_unavailable');
      const connector = h.connector(h.first, handle);
      const policy = h.currentPolicy();
      const limit = Math.min(100, policy.maxRetainedDocuments, policy.maxChangedPerLease);
      return {
        connector, selection: { ids: ['a1'] }, present: 'a1', removed: 'b2', cursor: h.server.profileHistory,
        oversized: Array.from({ length: limit + 1 }, (_, n) => (n + 1).toString(16)),
        requests: () => h.server.trace.length,
        failChanges: () => h.server.enqueue(paths.history, failure(503, 'backendError')),
        close: async () => {
          connector.dispose();
          try { await h.first.store.release(handle); } finally { await h.close(); }
        },
      };
    } catch (error) {
      await h.close();
      throw error;
    }
  },
});
