/**
 * Compiled by `test/scheduler-option.test.ts` through the TypeScript compiler under the package's own
 * options, since vitest runs the tests without checking their types: the package declares the
 * scheduler's surface it calls structurally, and each declaration here holds only while the
 * scheduler `@framers/agentos-ext-triggers` builds is that surface and what the package registers is
 * a definition that scheduler takes; each `@ts-expect-error` holds only while the option refuses what
 * follows it. Not a test file of its own, and outside the build (`tsconfig.json` compiles `src` alone).
 */
import type { JobDefinition, Scheduler, SchedulerInternals } from '@framers/agentos-ext-triggers';
import type { OpsJobDefinition, OpsOptions, OpsScheduler } from '../../src/contract.js';

/** The scheduler a product builds is the option as it is. */
export const real = (scheduler: Scheduler): OpsScheduler => scheduler;
/** So is the one a product's tests build, with its hand-driven tick. */
export const forTests = (scheduler: SchedulerInternals): NonNullable<OpsOptions['scheduler']> => scheduler;
/** What the package registers is a definition the scheduler takes. */
export const registered = (definition: OpsJobDefinition): JobDefinition => definition;
/** The option's run handler reads the job's name and the run's outcome and end from what the scheduler hands over. */
export const handler = (scheduler: Scheduler): void => {
  const options: Pick<OpsOptions, 'scheduler'> = { scheduler };
  options.scheduler?.onRun((job, run) => (run.outcome === 'running' || run.endedAt === null ? undefined : job.name.length));
};

// @ts-expect-error a scheduler with no onRun
export const noOnRun: OpsScheduler = { register: () => undefined };
// @ts-expect-error a definition whose schedule is a one-shot time, which the package never registers
export const oneShot: OpsJobDefinition['schedule'] = { kind: 'at', at: 0 };
