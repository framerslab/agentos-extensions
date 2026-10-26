/**
 * @fileoverview A request's rows and views (D8, D9, D11): the row as the adapter answers it
 * (PostgreSQL's bigint columns come back as strings, so every number is read through `Number`),
 * the derived state people read, the SQL of the waiting conditions every count shares, and the
 * person's and staff's views of a request. The derived state: a closed request is `closed`, a
 * resolved one `resolved`; an open one waits on the team while the person's message is the latest
 * or no staff message exists, and on the person otherwise, so a thread staff or the product opened
 * with no message of the person's waits on the person. `views.today()` counts the same condition.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsDerivedState, OpsIdentityState, OpsStaffTicket, OpsTicket, OpsTicketPriority, OpsTicketState } from '../contract.js';

/** A row of `<prefix>_tickets`; a time is a number or, from PostgreSQL's bigint, a string. */
export interface TicketRow {
  readonly id: string;
  readonly account_id: string;
  readonly anonymous_id: string;
  readonly subject: string;
  readonly category: string;
  readonly priority: OpsTicketPriority;
  readonly state: OpsTicketState;
  readonly source: 'person' | 'staff' | 'system';
  readonly claimed_by: string | null;
  readonly share_identity: number | string | boolean;
  readonly identity_opened_at: number | string | null;
  readonly consent_at: number | string | null;
  readonly consent_version: string | null;
  readonly plan_at_open: string | null;
  readonly person_read_at: number | string | null;
  readonly staff_read_at: number | string | null;
  readonly last_person_at: number | string | null;
  readonly last_staff_at: number | string | null;
  readonly last_system_at: number | string | null;
  readonly last_mail_at: number | string | null;
  readonly resolved_at: number | string | null;
  readonly closed_at: number | string | null;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

/** A time column: null stays null, a string from PostgreSQL's bigint becomes a number. */
export const timeOf = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** A number column that is never null. */
export const numberOf = (value: unknown): number => Number(value ?? 0);

/** A 0 or 1 flag column, as either engine answers it. */
export const flagOf = (value: unknown): boolean => value === true || value === 't' || Number(value) === 1;

/** The time of a request's newest message, person's, staff's or the system's, or null when it has none. */
export function latestMessageAt(row: TicketRow): number | null {
  const times = [timeOf(row.last_person_at), timeOf(row.last_staff_at), timeOf(row.last_system_at)].filter((time): time is number => time !== null);
  return times.length === 0 ? null : Math.max(...times);
}

/** D9: the state people read, from the stored state and the latest messages. */
export function derivedStateOf(row: TicketRow): OpsDerivedState {
  if (row.state === 'closed') return 'closed';
  if (row.state === 'resolved') return 'resolved';
  const person = timeOf(row.last_person_at);
  const staff = timeOf(row.last_staff_at);
  return person !== null && (staff === null || person >= staff) ? 'waiting_team' : 'waiting_person';
}

/** The SQL of "waiting on the team" over the table alias `t` (with its dot), or over the bare table when `t` is empty. */
export const waitingTeamSql = (t = ''): string =>
  `${t}state = 'open' AND ${t}last_person_at IS NOT NULL AND (${t}last_staff_at IS NULL OR ${t}last_person_at >= ${t}last_staff_at)`;

/** The SQL of "waiting on the person": open, and either no message of the person's or staff's message is the latest. */
export const waitingPersonSql = (t = ''): string =>
  `${t}state = 'open' AND (${t}last_person_at IS NULL OR (${t}last_staff_at IS NOT NULL AND ${t}last_person_at < ${t}last_staff_at))`;

/** The SQL of one derived state as a filter over the alias `t`. */
export function derivedStateSql(state: OpsDerivedState | 'open', t = ''): string {
  switch (state) {
    case 'open':
      return `${t}state = 'open'`;
    case 'waiting_team':
      return waitingTeamSql(t);
    case 'waiting_person':
      return waitingPersonSql(t);
    case 'resolved':
      return `${t}state = 'resolved'`;
    case 'closed':
      return `${t}state = 'closed'`;
    default:
      return `${t}state = 'open'`;
  }
}

/** The request as the person sees it: `unread` while a staff message is newer than the person's last read. */
export function personTicket(row: TicketRow): OpsTicket {
  const lastStaff = timeOf(row.last_staff_at);
  const read = timeOf(row.person_read_at);
  return {
    id: row.id,
    anonymousId: row.anonymous_id,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    state: row.state,
    derivedState: derivedStateOf(row),
    source: row.source,
    shareIdentity: flagOf(row.share_identity),
    identityOpenedAt: timeOf(row.identity_opened_at),
    createdAt: numberOf(row.created_at),
    updatedAt: numberOf(row.updated_at),
    lastPersonAt: timeOf(row.last_person_at),
    lastStaffAt: lastStaff,
    unread: lastStaff !== null && (read === null || lastStaff > read),
  };
}

/** The identity shape staff may read, once shared or opened. */
export type StaffIdentity = OpsStaffTicket['identity'];

/**
 * The request as staff see it (D11): the person's view with the plan, the claim and, once shared
 * or opened, the identity; `unread` while the person's latest message is newer than staff's last read.
 */
export function staffTicket(row: TicketRow, identity: StaffIdentity, identityState: OpsIdentityState): OpsStaffTicket {
  const view = personTicket(row);
  const lastPerson = timeOf(row.last_person_at);
  const read = timeOf(row.staff_read_at);
  return {
    ...view,
    unread: lastPerson !== null && (read === null || lastPerson > read),
    plan: row.plan_at_open,
    claimedBy: row.claimed_by,
    identity,
    identityState,
  };
}

/** Whether staff may read the identity behind `row`: shared or opened (D11). */
export const identityVisible = (row: TicketRow): boolean => flagOf(row.share_identity) || timeOf(row.identity_opened_at) !== null;

/** The row of `id`, or null. */
export async function loadTicket(db: StorageAdapter, table: string, id: string): Promise<TicketRow | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  return db.get<TicketRow>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
}

/** The row of `id` when it is `accountId`'s request, or null (so another person's request is `not_found`, D4). */
export async function loadOwnTicket(db: StorageAdapter, table: string, id: string, accountId: string): Promise<TicketRow | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  return db.get<TicketRow>(`SELECT * FROM ${table} WHERE id = ? AND account_id = ?`, [id, accountId]);
}

/**
 * The row of `id` read through `writer`, a write's transaction, and on PostgreSQL locked until it
 * ends (`FOR UPDATE`), so two writes on one request take their message times in turn and a stream's
 * cursor misses neither; SQLite runs one transaction at a time itself. Null when the request is gone.
 */
export async function lockTicket(writer: StorageAdapter, table: string, id: string, postgres: boolean): Promise<TicketRow | null> {
  return writer.get<TicketRow>(`SELECT * FROM ${table} WHERE id = ?${postgres ? ' FOR UPDATE' : ''}`, [id]);
}
