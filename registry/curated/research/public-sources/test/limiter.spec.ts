import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimiterRefused, retryAfterMs, SourceLimiter } from '../src/limiter';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

/** A task that resolves when told to. */
function gate(): { task: () => Promise<string>; open: () => void } {
  let open!: () => void;
  const done = new Promise<string>((resolve) => {
    open = () => resolve('ok');
  });
  return { task: () => done, open };
}

describe('SourceLimiter', () => {
  it('runs three at once and starts them at least 250 ms apart', async () => {
    const limiter = new SourceLimiter();
    const gates = [gate(), gate(), gate()];
    const starts: number[] = [];
    const runs = gates.map((g) => limiter.run(async () => {
      starts.push(Date.now());
      return g.task();
    }));
    await vi.advanceTimersByTimeAsync(600);
    expect(starts.map((at) => at - starts[0]!)).toEqual([0, 250, 500]);
    gates.forEach((g) => g.open());
    await expect(Promise.all(runs)).resolves.toEqual(['ok', 'ok', 'ok']);
  });

  it('makes a fourth wait for a slot, and refuses it after two seconds without one', async () => {
    const limiter = new SourceLimiter();
    const held = [gate(), gate(), gate()];
    held.forEach((g) => void limiter.run(g.task));
    const fourth = limiter.run(async () => 'late');
    const refused = expect(fourth).rejects.toMatchObject({ name: 'LimiterRefused', reason: 'wait' });
    await vi.advanceTimersByTimeAsync(2100);
    await refused;
    held.forEach((g) => g.open());
  });

  it('refuses at once when 200 started in the last minute, and starts again once the minute has passed', async () => {
    const limiter = new SourceLimiter({ spacingMs: 0 });
    for (let i = 0; i < 200; i += 1) await limiter.run(async () => i);
    await expect(limiter.run(async () => 'x')).rejects.toMatchObject({ reason: 'minute' });
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(limiter.run(async () => 'y')).resolves.toBe('y');
  });

  it("blocks for Retry-After's seconds or date, five seconds without it, an hour at most", async () => {
    const now = Date.now();
    expect(retryAfterMs('7', now)).toBe(7000);
    expect(retryAfterMs(new Date(now + 9000).toUTCString(), now)).toBe(9000);
    expect(retryAfterMs(null, now)).toBe(5000);
    expect(retryAfterMs('soon', now)).toBe(5000);
    expect(retryAfterMs('999999', now)).toBe(3_600_000);
    const limiter = new SourceLimiter();
    limiter.block('7');
    await expect(limiter.run(async () => 'x')).rejects.toMatchObject({ reason: 'blocked' });
    await vi.advanceTimersByTimeAsync(7001);
    await expect(limiter.run(async () => 'y')).resolves.toBe('y');
  });

  it('refuses a caller whose signal is already aborted, without starting it', async () => {
    const limiter = new SourceLimiter();
    const task = vi.fn(async () => 'x');
    await expect(limiter.run(task, AbortSignal.abort())).rejects.toThrow();
    expect(task).not.toHaveBeenCalled();
    expect(new LimiterRefused('wait').name).toBe('LimiterRefused');
  });

  it('stamps a start only once beforeStart has settled: its refusal spends no start, and a block that came meanwhile refuses', async () => {
    const limiter = new SourceLimiter({ perMinute: 1 });
    const refusing = () => {
      throw new LimiterRefused('caller');
    };
    await expect(limiter.run(async () => 'x', undefined, refusing)).rejects.toMatchObject({ reason: 'caller' });
    let settle!: () => void;
    const held = limiter.run(async () => 'y', undefined, () => new Promise<void>((resolve) => {
      settle = resolve;
    }));
    // The request still in its beforeStart holds the minute's one start.
    await expect(limiter.run(async () => 'z')).rejects.toMatchObject({ reason: 'minute' });
    limiter.block('5');
    settle();
    await expect(held).rejects.toMatchObject({ reason: 'blocked' });
    await vi.advanceTimersByTimeAsync(5001);
    await expect(limiter.run(async () => 'w')).resolves.toBe('w');
  });
});
