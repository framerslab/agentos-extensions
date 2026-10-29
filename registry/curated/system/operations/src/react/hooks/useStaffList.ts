/**
 * @fileoverview Staff's list of requests (D10, D39): `GET <base>` with the filter as its query,
 * where the client's base is the admin's support path; the answer carries the page, the four
 * counts and the 7-day line.
 */
import type { OpsStaffFilter, OpsStaffPage } from '../../contract.js';
import { queryOf, type OpsClient, type OpsRead } from '../client.js';
import { useRead } from './useRead.js';

/** Staff's requests under `filter`: state, category, claim, priority, the days opened in, words, and the page's cursor. */
export function useStaffList(client: OpsClient, filter: OpsStaffFilter = {}): OpsRead<OpsStaffPage> {
  const query = queryOf({
    state: filter.state,
    category: filter.category,
    claim: filter.claim,
    priority: filter.priority,
    openedDays: filter.openedDays,
    words: filter.words,
    cursor: filter.cursor,
  });
  return useRead<OpsStaffPage>(client, query);
}
