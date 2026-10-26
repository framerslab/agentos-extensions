/**
 * The people of the support tests: a person, another person, a third for the quota cases, and a
 * staff member; and the readers of an answer that is either a value or an `OpsRefusal`.
 */
import { expect } from 'vitest';
import type { OpsPerson, OpsRefusal, OpsStaff } from '../../src/contract.js';

export const PERSON: OpsPerson = { accountId: 'acct_person_0000000000000000001', plan: 'free' };
export const OTHER: OpsPerson = { accountId: 'acct_person_0000000000000000002', plan: 'plus' };
export const THIRD: OpsPerson = { accountId: 'acct_person_0000000000000000003', plan: 'free' };
export const STAFF: OpsStaff = { accountId: 'acct_staff_00000000000000000001', role: 'support' };
export const OWNER: OpsStaff = { accountId: 'acct_staff_00000000000000000002', role: 'owner' };

/** Whether `answer` is a refusal. */
export function isRefusal(answer: unknown): answer is OpsRefusal {
  return typeof answer === 'object' && answer !== null && typeof (answer as { refused?: unknown }).refused === 'string';
}

/** The answer when it is not a refusal; fails the test with the refusal's words otherwise. */
export function ok<T>(answer: T | OpsRefusal): T {
  if (isRefusal(answer)) throw new Error(`refused: ${answer.refused} (${answer.status})`);
  return answer;
}

/** Fails the test unless `answer` is the refusal `refused` with `status`; answers it. */
export function refusedAs(answer: unknown, refused: string, status: number): OpsRefusal {
  expect(isRefusal(answer), `expected the refusal ${refused}, got ${JSON.stringify(answer)}`).toBe(true);
  const refusal = answer as OpsRefusal;
  expect([refusal.refused, refusal.status]).toEqual([refused, status]);
  return refusal;
}

/** The rows of `table` under `prefix`, every column. */
export const rowsOf = async (db: { all<T>(sql: string, parameters?: unknown[]): Promise<T[]> }, prefix: string, table: string, where = '', parameters: unknown[] = []) =>
  db.all<Record<string, unknown>>(`SELECT * FROM ${prefix}_${table}${where ? ` WHERE ${where}` : ''}`, parameters);

/** How many rows `table` holds under `prefix`. */
export async function countOf(db: { get<T>(sql: string, parameters?: unknown[]): Promise<T | null> }, prefix: string, table: string, where = '', parameters: unknown[] = []): Promise<number> {
  const row = await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${prefix}_${table}${where ? ` WHERE ${where}` : ''}`, parameters);
  return Number(row?.n ?? 0);
}
