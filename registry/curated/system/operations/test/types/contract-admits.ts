/**
 * Compiled by `test/system-target.test.ts` through the TypeScript compiler under the package's own
 * options, since vitest runs the tests without checking their types: each declaration holds only
 * while the contract admits what it names, and each `@ts-expect-error` only while the contract
 * refuses what follows it. Not a test file of its own, and outside the build (`tsconfig.json`
 * compiles `src` alone).
 */
import type { OpsAuditKind, OpsPermission, Tickets } from '../../src/contract.js';

/** The permission a product maps to the role that pauses, resumes and runs a scheduled job by hand. */
export const manage: OpsPermission = 'ops.manage';

/** The audit kinds the host's one `audit` hook is given when staff pause, resume or run a job. */
export const jobKinds: readonly OpsAuditKind[] = ['job_paused', 'job_resumed', 'job_run'];

/** `systemMessage`'s seventh parameter: the request a message goes to, or none. */
type Target = Parameters<Tickets['systemMessage']>[6];
export const target: Target = { ticketId: 'tkt_1' };
export const noTarget: Target = undefined;
export const targeted = (tickets: Tickets) => tickets.systemMessage('acct_1', 'other', 'job_ran_again', { job: 'x' }, 'job_stall', 'x:1', { ticketId: 'tkt_1' });

// @ts-expect-error a permission the contract does not name
export const unknownPermission: OpsPermission = 'ops.write';
// @ts-expect-error an audit kind the contract does not name
export const unknownKind: OpsAuditKind = 'job_deleted';
// @ts-expect-error a target without the request's id
export const emptyTarget: Target = {};
