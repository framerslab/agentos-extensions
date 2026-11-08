/**
 * Compiled by `test/system-target.test.ts` through the TypeScript compiler under the package's own
 * options, since vitest runs the tests without checking their types: each declaration holds only
 * while the contract admits what it names, and each `@ts-expect-error` only while the contract
 * refuses what follows it. Not a test file of its own, and outside the build (`tsconfig.json`
 * compiles `src` alone).
 */
import type { Alerts, OpsAlertRow, OpsAuditKind, OpsDiscordAnswer, OpsOptions, OpsPermission, Tickets } from '../../src/contract.js';

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

/** The `discord` hook: the post, the handle to read through, and the claim's deadline as a signal it hands to its sender. */
export const discordHook: NonNullable<OpsOptions['discord']> = async (post, _db, signal) =>
  signal.aborted ? { outcome: 'failed', status: null } : { outcome: 'sent', deliveryId: post.dedupKey };
/** A hook that takes the post alone still fits. */
export const oneParameterHook: NonNullable<OpsOptions['discord']> = async () => ({ outcome: 'retry', afterMs: 30_000, status: 429 });
/** The outbox's surface and a row's states. */
export const drain = (alerts: Alerts) => alerts.sendDue(0).then((counts) => counts.sent + counts.retried + counts.failed + counts.dropped);
export const delivered: OpsAlertRow['state'] = 'delivered';
export const mailOwed: OpsAlertRow['mailState'] = 'owed';

// @ts-expect-error an answer outside the three outcomes
export const unknownAnswer: OpsDiscordAnswer = { outcome: 'queued' };
// @ts-expect-error a row state the contract does not name
export const unknownState: OpsAlertRow['state'] = 'sent';
