/**
 * @fileoverview The person's list of requests (D39): `GET <base>/requests`, newest first, 25 a
 * page by the cursor the answer carries.
 */
import type { OpsTicket } from '../../contract.js';
import { queryOf, type OpsClient, type OpsRead } from '../client.js';
import { useRead } from './useRead.js';

/** What the person's list answers. */
export interface OpsRequestsPage {
  readonly tickets: readonly OpsTicket[];
  readonly cursor: string | null;
}

/** The person's requests, one page: `cursor` names the page after the first. */
export function useRequests(client: OpsClient, cursor?: string | null): OpsRead<OpsRequestsPage> {
  return useRead<OpsRequestsPage>(client, `/requests${queryOf({ cursor: cursor ?? undefined })}`);
}
