/**
 * Compiled by `test/http-jobs.test.ts` through the TypeScript compiler under the package's own
 * options, since vitest runs the tests without checking their types: the handlers declare the
 * scheduler's reads and commands they call structurally, and each declaration here holds only while
 * the scheduler `@framers/agentos-ext-triggers` builds is that surface; each `@ts-expect-error`
 * holds only while the options refuse what follows it. Not a test file of its own, and outside the
 * build (`tsconfig.json` compiles `src` alone).
 */
import type { Scheduler, SchedulerInternals } from '@framers/agentos-ext-triggers';
import type { OpsHandlers, OpsHandlersOptions, OpsJobsRefusal, OpsJobsScheduler, OpsOptions } from '../../src/contract.js';
import { createHandlers } from '../../src/http/index.js';

/** The scheduler a product builds is the handlers' scheduler as it is. */
export const real = (scheduler: Scheduler): OpsJobsScheduler => scheduler;
/** So is the one a product's tests build. */
export const forTests = (scheduler: SchedulerInternals): OpsJobsScheduler => scheduler;
/** One scheduler serves both packages: the operations option and the handlers' scheduler. */
export const both = (scheduler: Scheduler, options: Omit<OpsOptions, 'scheduler'>, auth: OpsHandlersOptions['auth'], operations: OpsHandlersOptions['operations']): readonly [OpsOptions, OpsHandlers] => [
  { ...options, scheduler },
  createHandlers({ auth, operations, scheduler, changes: async () => [] }),
];
/** A host's refusal answers a Response of its own shape. */
export const refusal: NonNullable<OpsHandlersOptions['refusal']> = (answer: OpsJobsRefusal) => new Response(JSON.stringify({ error: { kind: answer.refused } }), { status: answer.status });
/** Each handler takes the request and the route's name. */
export const handler = (handlers: OpsHandlers, request: Request): Promise<Response> => handlers.jobs.pause(request, { name: 'ticket_routing' });

// @ts-expect-error a scheduler with no runNow
export const noRunNow: OpsJobsScheduler = { list: async () => ({ jobs: [], cursor: null }), get: async () => null, runs: async () => [], missed: async () => [], pause: async () => null, resume: async () => null };
// @ts-expect-error a changes hook answering a record without its kind
export const noKind: OpsHandlersOptions['changes'] = async () => [{ at: 0, staffAccountId: 'acct_1', staffName: null, note: null }];
