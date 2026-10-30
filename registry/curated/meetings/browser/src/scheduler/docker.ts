import type Dockerode from 'dockerode';
import { readMeetingLogDriver, type MeetingLogDriver } from './log-driver.js';

/** A container as the scheduler commands it after its start; `dockerode`'s `Container` is one. */
export interface ContainerLike {
  /** Stops the container, killing it after `t` seconds. */
  stop(opts?: { t?: number }): Promise<void>;
  /** Removes the container; `force` kills a running one first. */
  remove(opts?: { force?: boolean }): Promise<void>;
  /** Resolves with the exit code once the container stops. */
  wait(): Promise<{ StatusCode: number }>;
  /** With `hijack`, the stream is the container's stdin: what is written reaches the bot, and ending it closes its stdin. */
  attach(opts: { stream: boolean; stdin: boolean; hijack: boolean }): Promise<NodeJS.WritableStream>;
}

/** The part of a Docker client the scheduler uses; `dockerode`'s `Docker` is one, and the tests pass a fake. */
export interface DockerLike {
  /** Creates a container from the options and answers a handle to start and watch it. */
  createContainer(options: Dockerode.ContainerCreateOptions): Promise<{ id: string; start(): Promise<void>; stop(opts?: { t?: number }): Promise<void>; remove(opts?: { force?: boolean }): Promise<void>; wait(): Promise<{ StatusCode: number }> }>;
  /** Lists containers, the stopped ones too with `all`, by label filters (`key=value`). */
  listContainers(options: { all: boolean; filters: Record<string, string[]> }): Promise<Array<{ Id: string; State: string; Labels: Record<string, string> }>>;
  /** A handle on an existing container by its id. */
  getContainer(id: string): ContainerLike;
}

/** The scheduler's fixed container policy: the image and the limits come from its configuration, never from a request. */
export interface ContainerPolicy {
  /** The bot image, by tag or digest. */
  image: string;
  /** The Docker network the containers join (the bots' bridge, never the host's network). */
  network: string;
  /** The memory limit per container, in bytes. */
  memoryBytes: number;
  /** The CPU limit per container, in billionths of a CPU. */
  nanoCpus: number;
  /** The most processes a container may hold. */
  pidsLimit: number;
  /** The size of `/dev/shm`, in bytes (Chromium's shared memory). */
  shmBytes: number;
  /**
   * The seccomp profile as its JSON text. The Engine API takes the profile itself in `SecurityOpt` (the `docker` command
   * reads a file and sends its contents), so the scheduler's entry point reads `MEETING_SECCOMP_PROFILE` once at start.
   */
  seccompProfile?: string;
  /** The encrypted profile volume's mount point on the host; a run's profile is `<root>/<identity>`. */
  profilesRoot?: string;
  /**
   * The identity a Google Meet run naming none takes, and that folder alone: the one a request from a provider that
   * names no identity joins as, read from configuration and never computed from the pool's state. Required with
   * `profilesRoot`.
   */
  defaultIdentity?: string;
  /** The channel's url as the containers reach it. */
  channelUrl: string;
  /** Explicit journal logging for newly created bots; omission inherits the daemon's driver unchanged. */
  logDriver?: MeetingLogDriver;
}

/** The label that names a container's run. */
export const LABEL_RUN = 'dev.frame.meeting.run';
/** The label that names the worker a container belongs to. */
export const LABEL_WORKER = 'dev.frame.meeting.worker';
/** Where an identity's profile is mounted inside the container. */
export const PROFILE_MOUNT = '/home/bot/profile';

/**
 * The container's create options: nothing customer-supplied, only the run id and the channel's address. Its stdin stays
 * open for one attached writer, which is how the run's token reaches the bot without appearing in `docker inspect`.
 */
export function containerOptions(policy: ContainerPolicy, runId: string, workerId: string, profileDir: string | undefined): Dockerode.ContainerCreateOptions {
  const logDriver = readMeetingLogDriver(policy.logDriver);
  return {
    Image: policy.image,
    name: `meeting-bot-${runId}`,
    Labels: { [LABEL_RUN]: runId, [LABEL_WORKER]: workerId },
    Env: [`MEETING_CHANNEL_URL=${policy.channelUrl}`, `MEETING_RUN_ID=${runId}`],
    OpenStdin: true,
    StdinOnce: true,
    HostConfig: {
      NetworkMode: policy.network,
      ...(logDriver === 'journald' ? { LogConfig: { Type: 'journald', Config: { tag: '{{.Name}}' } } } : {}),
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges', ...(policy.seccompProfile ? [`seccomp=${policy.seccompProfile}`] : [])],
      Memory: policy.memoryBytes,
      NanoCpus: policy.nanoCpus,
      PidsLimit: policy.pidsLimit,
      ShmSize: policy.shmBytes,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=512m', '/home/bot/.cache': 'rw,noexec,nosuid,size=256m', '/run/pulse': 'rw,size=16m' },
      Binds: profileDir ? [`${profileDir}:${PROFILE_MOUNT}:rw`] : [],
      AutoRemove: false,
      RestartPolicy: { Name: 'no' },
    },
  };
}
