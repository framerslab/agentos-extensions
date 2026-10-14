#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import Dockerode from 'dockerode';
import { createLogger } from '@framers/agentos';
import { parseListenAddresses, Scheduler, type SchedulerOptions } from './server.js';

const log = createLogger('meeting-scheduler');

/** An environment variable the scheduler cannot start without. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** An environment variable that may be absent; an empty value counts as absent. */
function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error';
}

/** Ends the process with the code once the logger has had a moment to write its last line. */
function exit(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 200).unref();
}

/**
 * The scheduler's entry point, `agentos-meeting-scheduler`: its configuration from the environment, a Docker client on
 * the local socket, and a stop on `SIGTERM` or `SIGINT` that leaves the containers running for the next start to take
 * back. The client credential is read from the file `MEETING_CLIENT_TOKEN_FILE` names, never from the environment itself.
 */
async function main(): Promise<void> {
  const [listen, ...alsoListen] = parseListenAddresses(required('MEETING_LISTEN'));
  const workerId = required('MEETING_WORKER_ID');
  const slots = Number(required('MEETING_SLOTS'));
  const clientToken = readFileSync(required('MEETING_CLIENT_TOKEN_FILE'), 'utf8').trim();
  const policy: NonNullable<SchedulerOptions['policy']> = {};
  const profilesRoot = optional('MEETING_PROFILES_ROOT');
  if (profilesRoot) policy.profilesRoot = profilesRoot;
  const seccompFile = optional('MEETING_SECCOMP_PROFILE');
  // the Engine API takes the profile's JSON in the security option, as the docker command sends it, not the file's path
  if (seccompFile) policy.seccompProfile = JSON.stringify(JSON.parse(readFileSync(seccompFile, 'utf8')));
  const scheduler = new Scheduler({
    workerId,
    slots,
    clientToken,
    image: required('MEETING_BOT_IMAGE'),
    docker: new Dockerode(),
    listen,
    alsoListen,
    channelUrl: optional('MEETING_CHANNEL_URL'),
    stateRoot: optional('MEETING_STATE_ROOT'),
    policy,
    testHosts: (optional('MEETING_RESOLVE_ALLOW') ?? '').split(',').map((host) => host.trim()).filter(Boolean),
    logger: log,
  });
  await scheduler.start();
  log.info('the meeting scheduler is listening', { workerId, slots, addresses: alsoListen.length + 1 });
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('stopping the meeting scheduler; its containers keep running', { signal });
    scheduler.stop().then(
      () => exit(0),
      (err: unknown) => {
        log.error('the meeting scheduler did not stop cleanly', { error: describe(err) });
        exit(1);
      },
    );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err: unknown) => {
  log.error('the meeting scheduler did not start', { error: describe(err) });
  exit(1);
});
