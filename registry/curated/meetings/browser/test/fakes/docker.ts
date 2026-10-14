import { Writable } from 'node:stream';
import type Dockerode from 'dockerode';
import { LABEL_RUN, type ContainerLike, type DockerLike } from '../../src/scheduler/docker.js';

interface FakeContainer {
  id: string;
  name: string;
  runId: string | undefined;
  labels: Record<string, string>;
  state: 'created' | 'running' | 'exited';
  removed: boolean;
  exitCode?: number;
  waiters: Array<(result: { StatusCode: number }) => void>;
}

/** A Docker error as dockerode raises one: the Engine API's status on the error. */
function dockerError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * A small Docker for the scheduler's tests. It records what the scheduler did (`created`, `stopped`, `removed`, what
 * reached each run's stdin), keeps its containers across scheduler instances, and lets a test end a run's container
 * (`exit`) or add one the scheduler never started (`addStray`). Records name a container by its run label; a name in use
 * is refused as Docker refuses it.
 */
export class FakeDocker implements DockerLike {
  /** The create options of every container, in order. */
  readonly created: Dockerode.ContainerCreateOptions[] = [];
  /** The run of every container stopped while it ran, by a stop or a forced remove. */
  readonly stopped: string[] = [];
  /** The run of every container removed. */
  readonly removed: string[] = [];
  /** What was written to each run's stdin; the newest container's when a run had two. */
  readonly stdin = new Map<string, string>();
  /** The runs whose stdin was closed after the write. */
  readonly stdinClosed = new Set<string>();
  /** The next call of this kind fails, once. */
  failNext: 'create' | 'start' | 'attach' | undefined;
  private readonly containers = new Map<string, FakeContainer>();
  private nextId = 1;

  async createContainer(options: Dockerode.ContainerCreateOptions) {
    if (this.failNext === 'create') {
      this.failNext = undefined;
      throw dockerError(500, 'create failed');
    }
    const id = `c${this.nextId++}`;
    const name = options.name ?? id;
    if ([...this.containers.values()].some((c) => !c.removed && c.name === name)) throw dockerError(409, `the container name ${name} is already in use`);
    const labels = { ...(options.Labels ?? {}) };
    this.containers.set(id, { id, name, runId: labels[LABEL_RUN], labels, state: 'created', removed: false, waiters: [] });
    this.created.push(options);
    const handle = this.getContainer(id);
    return { id, start: () => this.start(id), stop: handle.stop, remove: handle.remove, wait: handle.wait };
  }

  async listContainers(options: { all: boolean; filters: Record<string, string[]> }) {
    const wanted = options.filters.label ?? [];
    return [...this.containers.values()]
      .filter((c) => !c.removed && (options.all || c.state === 'running'))
      .filter((c) =>
        wanted.every((filter) => {
          const at = filter.indexOf('=');
          return at < 0 ? filter in c.labels : c.labels[filter.slice(0, at)] === filter.slice(at + 1);
        }),
      )
      .map((c) => ({ Id: c.id, State: c.state, Labels: { ...c.labels } }));
  }

  getContainer(id: string): ContainerLike {
    return {
      stop: async () => {
        const c = this.live(id);
        if (c.state !== 'running') throw dockerError(304, 'container already stopped');
        this.stopped.push(this.key(c));
        this.finish(c, 137);
      },
      remove: async (opts?: { force?: boolean }) => {
        const c = this.live(id);
        if (c.state === 'running') {
          if (!opts?.force) throw dockerError(409, 'the container is running');
          this.stopped.push(this.key(c));
          this.finish(c, 137);
        }
        c.removed = true;
        this.removed.push(this.key(c));
      },
      wait: () => {
        const c = this.containers.get(id);
        if (!c || c.removed) return Promise.reject(dockerError(404, 'no such container'));
        if (c.state === 'exited') return Promise.resolve({ StatusCode: c.exitCode ?? 0 });
        return new Promise<{ StatusCode: number }>((resolve) => c.waiters.push(resolve));
      },
      attach: async () => {
        const c = this.live(id);
        if (this.failNext === 'attach') {
          this.failNext = undefined;
          throw dockerError(500, 'attach failed');
        }
        const key = this.key(c);
        this.stdin.set(key, '');
        return new Writable({
          write: (chunk: Buffer, _encoding, callback) => {
            this.stdin.set(key, (this.stdin.get(key) ?? '') + Buffer.from(chunk).toString('utf8'));
            callback();
          },
          final: (callback) => {
            this.stdinClosed.add(key);
            callback();
          },
        });
      },
    };
  }

  /** Ends the newest running container of the run with the exit code, as the bot's process would. */
  exit(runId: string, code: number): void {
    const c = [...this.containers.values()].reverse().find((x) => x.runId === runId && x.state === 'running');
    if (!c) throw new Error(`no running container for ${runId}`);
    this.finish(c, code);
  }

  /** Adds a running container the scheduler did not start, with these labels. */
  addStray(name: string, labels: Record<string, string>): void {
    const id = `c${this.nextId++}`;
    this.containers.set(id, { id, name, runId: labels[LABEL_RUN], labels: { ...labels }, state: 'running', removed: false, waiters: [] });
  }

  /** Whether the run has a running container. */
  running(runId: string): boolean {
    return [...this.containers.values()].some((c) => c.runId === runId && c.state === 'running');
  }

  private async start(id: string): Promise<void> {
    const c = this.live(id);
    if (this.failNext === 'start') {
      this.failNext = undefined;
      throw dockerError(500, 'start failed');
    }
    c.state = 'running';
  }

  private live(id: string): FakeContainer {
    const c = this.containers.get(id);
    if (!c || c.removed) throw dockerError(404, 'no such container');
    return c;
  }

  private key(c: FakeContainer): string {
    return c.runId ?? c.name;
  }

  private finish(c: FakeContainer, code: number): void {
    c.state = 'exited';
    c.exitCode = code;
    for (const resolve of c.waiters.splice(0)) resolve({ StatusCode: code });
  }
}
