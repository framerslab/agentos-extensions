/**
 * @fileoverview The bounds every call to Google runs under, shared by the grant's transport and Drive's calls: one
 * deadline joined with the callers' signals, a request that stops being waited on once that deadline's signal aborts,
 * whatever the fetch does with the signal it is handed, and an answer's body read under a byte cap through a bridge that
 * ends with the call. No stream's cancellation is awaited, so neither the cap nor the deadline waits on a stream whose
 * cancellation never settles.
 * @module agentos-ext-google-drive/bounded
 */

import { readCapped } from '@framers/agentos-ext-account-sources';

/** Cancels an answer's body without waiting, ignoring a failure to. */
export function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** One call's deadline: its own timer joined with the signals of its callers. */
export interface CallDeadline {
  /** Aborts when the call's time has passed or a caller's signal aborts, whichever comes first. */
  readonly signal: AbortSignal;
  /** True once the call's own time has passed, as against a caller's cancellation. */
  timedOut(): boolean;
  /** Clears the timer and stops watching the callers' signals. Call it once the call has ended. */
  end(): void;
}

/**
 * Starts a call's deadline: a signal that aborts after `ms` milliseconds or as soon as one of `callers` aborts. A
 * caller's signal that has already aborted aborts it at once.
 *
 * @param callers The signals of the call's callers.
 * @param ms How long the call may take, its answer included.
 */
export function callDeadline(callers: readonly AbortSignal[], ms: number): CallDeadline {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  for (const caller of callers) caller.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  if (callers.some((caller) => caller.aborted)) controller.abort();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    end() {
      clearTimeout(timer);
      for (const caller of callers) caller.removeEventListener('abort', abort);
    },
  };
}

/**
 * Settles as `work` does, or rejects with `stopped()` as soon as `signal` aborts, whichever comes first, even when
 * `work` never settles. What `work` answers after that is handed to `discard`, so an answer that arrives late is let go.
 *
 * @param work The request under way.
 * @param signal The call's signal.
 * @param stopped The failure a call stopped by `signal` throws.
 * @param discard Takes what `work` answers once the call has stopped waiting for it.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal, stopped: () => Error, discard: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const abort = (): void => {
      if (done) return;
      done = true;
      reject(stopped());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (done) {
          discard(value);
          return;
        }
        done = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        if (done) return;
        done = true;
        reject(error);
      },
    );
  });
}

/**
 * An answer's body read under `maxBytes`, `ReadCapExceeded` past it. The body is read through a bridge stream that ends
 * with the call: once `signal` aborts the read fails with `stopped()` at once, even while no bytes arrive, and the
 * answer's stream is cancelled, so nothing more of it is read. A body that fails otherwise fails with `failed()`. Nothing
 * is drawn from the body before the capped read asks for it, so a declared length past the cap is refused unread, and a
 * cancellation is asked for, never awaited: `readCapped` awaits the bridge's own before it throws past the cap.
 *
 * @param response The answer whose body is read.
 * @param maxBytes The most bytes read.
 * @param signal The call's signal.
 * @param stopped The failure a read stopped by `signal` throws.
 * @param failed The failure a body that breaks off throws.
 */
export async function cappedBody(response: Response, maxBytes: number, signal: AbortSignal, stopped: () => Error, failed: () => Error): Promise<Uint8Array> {
  if (signal.aborted) {
    discardBody(response);
    throw stopped();
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  let closed = false;
  let stop = (): void => {};
  const bridge = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        stop = () => {
          if (closed) return;
          closed = true;
          controller.error(stopped());
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      },
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (closed) return;
          if (chunk.done) {
            closed = true;
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch {
          if (closed) return;
          closed = true;
          controller.error(signal.aborted ? stopped() : failed());
        }
      },
      cancel() {
        closed = true;
        // Asked for, not awaited: `readCapped` awaits this cancellation before it throws past the cap. Nothing more of
        // the answer is kept.
        void reader.cancel().catch(() => {});
      },
    },
    // Nothing is drawn from the body before the capped read asks: a declared length past the cap is refused unread.
    { highWaterMark: 0 },
  );
  try {
    return await readCapped(new Response(bridge, { headers: response.headers }), maxBytes);
  } finally {
    signal.removeEventListener('abort', stop);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled stream may still be settling.
    }
  }
}
