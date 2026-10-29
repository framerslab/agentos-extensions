/**
 * @fileoverview One of the person's requests with its thread (D39): `GET <base>/requests/<id>`,
 * which marks the thread read; null reads nothing.
 */
import type { OpsMessage, OpsTicket } from '../../contract.js';
import type { OpsClient, OpsRead } from '../client.js';
import { useRead } from './useRead.js';

/** What one request answers: the request and its messages, oldest first. */
export interface OpsRequestView {
  readonly ticket: OpsTicket;
  readonly messages: readonly OpsMessage[];
}

/** The request `id` with its thread; `refresh()` reads it again after a write or a stream event. */
export function useRequest(client: OpsClient, id: string | null): OpsRead<OpsRequestView> {
  return useRead<OpsRequestView>(client, id === null ? null : `/requests/${encodeURIComponent(id)}`);
}
