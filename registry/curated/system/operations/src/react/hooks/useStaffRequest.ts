/**
 * @fileoverview One request as staff see it, with its thread (D11, D39): `GET <base>/<id>`, where
 * the client's base is the admin's support path; the answer holds the anonymous id and the plan,
 * or the name and address once shared or opened, never the account's id.
 */
import type { OpsMessage, OpsStaffTicket } from '../../contract.js';
import type { OpsClient, OpsRead } from '../client.js';
import { useRead } from './useRead.js';

/** What staff's request answers. */
export interface OpsStaffRequestView {
  readonly ticket: OpsStaffTicket;
  readonly messages: readonly OpsMessage[];
}

/** The request `id` as staff see it; `refresh()` reads it again after a reply, a claim or a state change. */
export function useStaffRequest(client: OpsClient, id: string | null): OpsRead<OpsStaffRequestView> {
  return useRead<OpsStaffRequestView>(client, id === null ? null : `/${encodeURIComponent(id)}`);
}
