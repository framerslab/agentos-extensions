/**
 * @fileoverview The refusals of the support surface (D12, D18, D21, D46): each is the contract's
 * `OpsRefusal`, which `./http` answers as `{ error }` with its status, and `OpsRefused` is the error
 * `exportAccount` throws, since its answer type carries no refusal. A refusal found inside a
 * write's transaction is thrown as `RefusedInside`, so the transaction rolls back whole and the
 * caller answers the refusal it carries; nothing of the write lands.
 */
import type { OpsRefusal } from '../contract.js';

/** A refusal with its status, and `retryAfter` in seconds when the caller may try again later. */
export function refusal(refused: string, status: number, retryAfter?: number): OpsRefusal {
  return retryAfter === undefined ? { refused, status } : { refused, status, retryAfter };
}

/** The answer for a request that is not the caller's, or none: never `forbidden`, so ids cannot be probed (D4). */
export const notFound = (): OpsRefusal => refusal('not_found', 404);

/** Whether `value` is a refusal. */
export function isRefusal(value: unknown): value is OpsRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { refused?: unknown }).refused === 'string' &&
    typeof (value as { status?: unknown }).status === 'number'
  );
}

/**
 * The error a function whose answer type carries no refusal throws (`exportAccount`, D21): the
 * refusal's word, its status and, when the caller may try again, `retryAfter` in seconds.
 */
export class OpsRefused extends Error implements OpsRefusal {
  readonly refused: string;
  readonly status: number;
  readonly retryAfter?: number;

  constructor(refused: string, status: number, retryAfter?: number) {
    super(`${refused}: refused with status ${status}`);
    this.name = 'OpsRefused';
    this.refused = refused;
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

/** A refusal found inside a transaction: thrown so the transaction rolls back, caught by `refusable`. */
export class RefusedInside extends Error {
  constructor(readonly refusal: OpsRefusal) {
    super(`refused inside a transaction: ${refusal.refused}`);
    this.name = 'RefusedInside';
  }
}

/** Throws `refused` so the transaction around it rolls back. */
export function refuseInside(refused: string, status: number, retryAfter?: number): never {
  throw new RefusedInside(refusal(refused, status, retryAfter));
}

/** Runs `work`; a `RefusedInside` it throws becomes the refusal it carries, and anything else is rethrown. */
export async function refusable<T>(work: () => Promise<T>): Promise<T | OpsRefusal> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RefusedInside) return error.refusal;
    throw error;
  }
}

/** Whole seconds until `atMs`, at least 1: the `Retry-After` a 429 carries. */
export function secondsUntil(atMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((atMs - nowMs) / 1000));
}
