/**
 * @fileoverview One of the person's requests with its thread (D39): `GET <base>/requests/<id>`,
 * which marks the thread read; null reads nothing. Since the read marks the thread read, a
 * `refresh()` belongs to a page the person can see (D14): a reply it reads behind a hidden page is
 * marked read and never mailed. A `useStream` event already carries the message to append, and the
 * stream hands its events on only while the page is visible, so a `refresh()` from its `onEvent`
 * never reads behind a hidden page.
 */
import type { OpsMessage, OpsTicket } from '../../contract.js';
import type { OpsClient, OpsRead } from '../client.js';
import { useRead } from './useRead.js';

/** What one request answers: the request and its messages, oldest first. */
export interface OpsRequestView {
  readonly ticket: OpsTicket;
  readonly messages: readonly OpsMessage[];
}

/** The request `id` with its thread; `refresh()` reads it again, and marks it read, after a write or a stream event, while the page is visible. */
export function useRequest(client: OpsClient, id: string | null): OpsRead<OpsRequestView> {
  return useRead<OpsRequestView>(client, id === null ? null : `/requests/${encodeURIComponent(id)}`);
}
