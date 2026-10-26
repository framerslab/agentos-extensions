/**
 * @fileoverview D12's limits: the text bounds of a request and a message, the pictures a message
 * and a request take, the quota and cooldown of opening (5 requests in 24 hours, 30 seconds apart,
 * both from one COUNT over the person's requests, wilds.ai's rule), and the message rate (30 an
 * hour across requests). Each refusal carries its status and, for a 429, the seconds until the
 * caller may try again.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsLimits, OpsOpenInput, OpsRefusal, OpsTicketWrite, OpsTicketsHost } from '../contract.js';
import { refusal, secondsUntil } from './refusals.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A text of 1 to `max` characters with something besides white space in it. */
const textWithin = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim().length > 0;

/** The picture ids of an input: a list of distinct non-empty strings, or null when the list is malformed. */
export function pictureIdsOf(input: { readonly pictureIds?: readonly string[] }): readonly string[] | null {
  const ids = input.pictureIds;
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) return null;
  return [...new Set(ids)];
}

/** The consent of an input: `{ version }` with a short string, null when none, undefined when malformed. */
export function consentOf(input: { readonly consent?: { readonly version: string } }): { readonly version: string } | null | undefined {
  const consent = input.consent;
  if (consent === undefined || consent === null) return null;
  if (typeof consent !== 'object' || typeof consent.version !== 'string' || consent.version.length === 0 || consent.version.length > 64) return undefined;
  return { version: consent.version };
}

/** Checks a new request's words (D12): the category one of the host's, the subject 1 to 200, the body 1 to 5,000; `refused` for anything else. */
export function checkOpenInput(input: unknown, limits: OpsLimits, host: OpsTicketsHost): OpsRefusal | null {
  if (typeof input !== 'object' || input === null) return refusal('refused', 400);
  const given = input as OpsOpenInput;
  if (typeof given.category !== 'string' || !host.categories.includes(given.category)) return refusal('refused', 400);
  if (!textWithin(given.subject, limits.subjectMax)) return refusal('refused', 400);
  if (!textWithin(given.body, limits.bodyMax)) return refusal('refused', 400);
  return checkPictures(given, limits);
}

/** Checks a message's words (D12): the body 1 to 5,000; `refused` for anything else. */
export function checkWriteInput(input: unknown, limits: OpsLimits): OpsRefusal | null {
  if (typeof input !== 'object' || input === null) return refusal('refused', 400);
  const given = input as OpsTicketWrite;
  if (!textWithin(given.body, limits.bodyMax)) return refusal('refused', 400);
  return checkPictures(given, limits);
}

/** The picture list's shape and its bound a message (D12): `too_many_pictures` past 3. */
function checkPictures(input: { readonly pictureIds?: readonly string[]; readonly consent?: { readonly version: string } }, limits: OpsLimits): OpsRefusal | null {
  const ids = pictureIdsOf(input);
  if (ids === null) return refusal('refused', 400);
  if (ids.length > limits.picturesPerMessage) return refusal('too_many_pictures', 409);
  if (consentOf(input) === undefined) return refusal('refused', 400);
  return null;
}

interface QuotaRow {
  readonly n: number | string | null;
  readonly oldest: number | string | null;
  readonly latest: number | string | null;
}

/**
 * D12's quota and cooldown from one COUNT over the person's own requests of the last 24 hours:
 * `ticket_quota` at the fifth, until the oldest of them is a day old; `ticket_cooldown` within
 * 30 seconds of the latest. Null when the person may open one.
 */
export async function checkOpenQuota(reader: StorageAdapter, table: string, accountId: string, nowMs: number, limits: OpsLimits): Promise<OpsRefusal | null> {
  const row = await reader.get<QuotaRow>(
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS latest FROM ${table}
     WHERE account_id = ? AND source = 'person' AND created_at > ?`,
    [accountId, nowMs - DAY_MS],
  );
  const count = Number(row?.n ?? 0);
  if (count >= limits.ticketsPerDay) {
    const oldest = Number(row?.oldest ?? nowMs);
    return refusal('ticket_quota', 429, secondsUntil(oldest + DAY_MS, nowMs));
  }
  const latest = row?.latest === null || row?.latest === undefined ? null : Number(row.latest);
  if (latest !== null && nowMs - latest < limits.ticketCooldownMs) {
    return refusal('ticket_cooldown', 429, secondsUntil(latest + limits.ticketCooldownMs, nowMs));
  }
  return null;
}

/**
 * D12's message rate from one COUNT over the person's messages of the last hour, the first
 * messages of their requests among them: `message_quota` at the thirtieth, until the oldest is an
 * hour old. Null when the person may write.
 */
export async function checkMessageRate(reader: StorageAdapter, table: string, accountId: string, nowMs: number, limits: OpsLimits): Promise<OpsRefusal | null> {
  const row = await reader.get<QuotaRow>(
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS latest FROM ${table}
     WHERE sender = 'person' AND sender_account_id = ? AND created_at > ?`,
    [accountId, nowMs - HOUR_MS],
  );
  const count = Number(row?.n ?? 0);
  if (count >= limits.messagesPerHour) {
    const oldest = Number(row?.oldest ?? nowMs);
    return refusal('message_quota', 429, secondsUntil(oldest + HOUR_MS, nowMs));
  }
  return null;
}

/** How many pictures `ticketId` holds, for D12's bound a request. */
export async function picturesOnTicket(reader: StorageAdapter, table: string, ticketId: string): Promise<number> {
  const row = await reader.get<{ n: number | string | null }>(`SELECT COUNT(id) AS n FROM ${table} WHERE ticket_id = ?`, [ticketId]);
  return Number(row?.n ?? 0);
}
