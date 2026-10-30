import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DRIVE_TIMEOUT_MS, downloadFile, driveAccount, driveFile, DriveNoAnswer, exportFile, GoogleDrivePickedConnector,
  type DriveCallOptions,
} from '../src/index.js';

/** The access token every stand-in is called with. */
const TOKEN = 'fake-drive-access-token';

/** A picked file's metadata as Drive answers it: a PDF of eight bytes the person owns. */
const PDF_META = {
  id: 'fake-pdf', name: 'Minutes.pdf', mimeType: 'application/pdf', version: '2', ownedByMe: true, size: '8',
  webViewLink: 'https://drive.example.test/fake-pdf/view', trashed: false,
};

/** Text as the bytes Drive would answer. */
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

/** What a caller asks to read: a picked id, nothing else known yet. */
const picked = (id: string) => ({ id, title: '', size: null, version: null });

/** A JSON answer. */
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Drive answering the PDF's metadata, and `content` answering its download. */
function pdfWith(content: typeof fetch): typeof fetch {
  return async (input, init) => (new URL(String(input)).searchParams.get('alt') === 'media' ? content(input, init) : json(PDF_META));
}

/** Each of Drive's four calls, over `fetchImpl` with `options`. */
function everyCall(fetchImpl: typeof fetch, options: Omit<DriveCallOptions, 'fetchImpl'> = {}): Array<() => Promise<unknown>> {
  const call: DriveCallOptions = { ...options, fetchImpl };
  return [
    () => driveFile(TOKEN, 'fake-pdf', call),
    () => exportFile(TOKEN, 'fake-doc', 'text/markdown', 10_485_760, call),
    () => downloadFile(TOKEN, 'fake-pdf', 10_485_760, call),
    () => driveAccount(TOKEN, call),
  ];
}

/** What `work` settled to within `ms` milliseconds of real time: its value, its error, or that it was still waiting. */
async function within(work: Promise<unknown>, ms = 2_000): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`still waiting after ${ms} ms`), ms);
  });
  try {
    return await Promise.race([work.then((value) => value, (error: unknown) => error), waited]);
  } finally {
    clearTimeout(timer);
  }
}

/** A fetch that never answers, rejecting with its signal's reason when the signal aborts, as fetch does. */
const neverAnswers: typeof fetch = async (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

/** A fetch that never answers and never looks at the signal it is handed, as a wrapper that drops the signal would. */
const ignoresSignal: typeof fetch = async () => new Promise<Response>(() => undefined);

/**
 * A fetch that answers `status` with the start of a body and then stalls, erroring the body when its signal aborts, as
 * fetch does to a body still streaming.
 */
function stallsInBody(status: number, start: string): typeof fetch {
  return async (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(text(start));
        if (signal) signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
}

/** A body a fetch left open: the fetch that answers it, the cancels it got, and when a read waits on it past its start. */
interface HeldBody {
  fetchImpl: typeof fetch;
  /** How many times the body was cancelled. */
  cancels(): number;
  /** Settles once a read waits on the body past its first chunk. */
  stalled: Promise<void>;
}

/**
 * A fetch that answers `status` with the start of a body, then stalls, leaving the body open when its signal aborts, as
 * a fetch that does not tie its answer's body to its signal would. It counts the body's cancels.
 */
function heldBody(status: number, start: string): HeldBody {
  let cancels = 0;
  let waiting = (): void => undefined;
  const stalled = new Promise<void>((resolve) => {
    waiting = () => resolve();
  });
  const fetchImpl: typeof fetch = async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(text(start));
          else waiting();
        },
        cancel() {
          cancels += 1;
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, cancels: () => cancels, stalled };
}

/**
 * A fetch whose 200 answer never ends, trickling in one byte every `everyMs`: no gap between its bytes is long, so a
 * timeout on the gaps alone, such as a fetch's own idle timeout, never ends it. It counts the body's cancels, and the
 * trickle stops at the first.
 */
function trickle(everyMs: number) {
  let cancels = 0;
  const fetchImpl: typeof fetch = async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => {
          try {
            controller.enqueue(text(' '));
          } catch {
            clearInterval(timer);
          }
        }, everyMs);
      },
      cancel() {
        cancels += 1;
        clearInterval(timer);
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, cancels: () => cancels };
}

/** A fetch whose 200 answer is `size` bytes, declared in its content-length or only streamed, and whose stream never finishes cancelling. */
function pastCap(size: number, declared: boolean) {
  let cancels = 0;
  const fetchImpl: typeof fetch = async () => {
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(size).fill(37));
        },
        cancel() {
          cancels += 1;
          // A cancellation that never settles.
          return new Promise<void>(() => undefined);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: 200, headers: declared ? { 'content-length': String(size) } : {} });
  };
  return { fetchImpl, cancels: () => cancels };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Exercises the deadline, the cancellation and the caps every Drive call runs under, the connector's included. */
describe("Drive's calls under their deadline", () => {
  /** With no timeoutMs a call ends at 60 seconds, the reading of its answer included, however steadily its bytes arrive. */
  it('ends a call at 60 seconds by default while its answer still trickles in, and cancels the rest of the answer', async () => {
    expect(DRIVE_TIMEOUT_MS).toBe(60_000);
    vi.useFakeTimers();
    const slow = trickle(1_000);
    const call = driveFile(TOKEN, 'fake-pdf', { fetchImpl: slow.fetchImpl });
    let outcome: unknown = 'pending';
    call.then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(2);
    expect(outcome).toBeInstanceOf(DriveNoAnswer);
    expect(outcome).toMatchObject({ name: 'DriveNoAnswer', reason: 'timeout', message: 'Drive gave no answer: timeout' });
    expect(slow.cancels()).toBe(1);
  });

  /** A change set asked for with no signal, as a daily read asks for one, ends at the default deadline rather than waiting on Drive. */
  it("ends the connector's calls at 60 seconds by default when Drive never answers", async () => {
    vi.useFakeTimers();
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000, fetchImpl: neverAnswers });
    const call = connector.changesSince(null, { ids: ['fake-pdf'] });
    let outcome: unknown = 'pending';
    call.then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(2);
    expect(outcome).toBeInstanceOf(DriveNoAnswer);
    expect(outcome).toMatchObject({ reason: 'timeout' });
  });

  /** The failing input: an answer trickling in a byte every 20 ms is ended at the call's deadline, not read on for hours. */
  it('ends each call at its timeoutMs while its answer trickles in a byte every 20 ms, and cancels the rest of the answer', async () => {
    for (let index = 0; index < 4; index += 1) {
      const slow = trickle(20);
      const outcome = await within(everyCall(slow.fetchImpl, { timeoutMs: 200 })[index]());
      expect(outcome).toBeInstanceOf(DriveNoAnswer);
      expect(outcome).toMatchObject({ reason: 'timeout', message: 'Drive gave no answer: timeout' });
      expect(slow.cancels()).toBe(1);
    }
  });

  /** The deadline holds whatever the fetch does with its signal: no answer, a request or a body left open, a refusal that stalls. */
  it('ends every call at its timeoutMs whatever the fetch does with the signal it is handed', async () => {
    const fetches = [
      neverAnswers,
      ignoresSignal,
      stallsInBody(200, '{"id":'),
      heldBody(200, '{"id":').fetchImpl,
      stallsInBody(403, '{"error":{"errors":[{"domain":"global","reason":'),
    ];
    for (const fetchImpl of fetches) {
      for (const call of everyCall(fetchImpl, { timeoutMs: 50 })) {
        const outcome = await within(call());
        expect(outcome).toBeInstanceOf(DriveNoAnswer);
        expect(outcome).toMatchObject({ reason: 'timeout', message: 'Drive gave no answer: timeout' });
      }
    }
  });

  /** The caller's cancel ends a call before Drive answers and while its answer is read, and cancels that answer's body. */
  it("ends a call at the caller's cancel, before Drive answers or while its answer is read, and cancels the answer's body", async () => {
    for (const fetchImpl of [neverAnswers, ignoresSignal]) {
      const controller = new AbortController();
      const pending = driveFile(TOKEN, 'fake-pdf', { fetchImpl, signal: controller.signal });
      controller.abort();
      const outcome = await within(pending);
      expect(outcome).toBeInstanceOf(DriveNoAnswer);
      expect(outcome).toMatchObject({ reason: 'cancelled', message: 'Drive gave no answer: cancelled' });
    }

    const held = heldBody(200, '{"id":');
    const controller = new AbortController();
    const pending = driveFile(TOKEN, 'fake-pdf', { fetchImpl: held.fetchImpl, signal: controller.signal });
    await held.stalled;
    controller.abort();
    expect(await within(pending)).toMatchObject({ name: 'DriveNoAnswer', reason: 'cancelled' });
    expect(held.cancels()).toBe(1);

    // Through the connector: the download's answer stalls, and the read is cancelled, never answered gone.
    const download = heldBody(200, '%PDF-1.7');
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000, fetchImpl: pdfWith(download.fetchImpl) });
    const reading = new AbortController();
    const read = connector.read(picked('fake-pdf'), reading.signal);
    await download.stalled;
    reading.abort();
    expect(await within(read)).toMatchObject({ name: 'DriveNoAnswer', reason: 'cancelled' });
    expect(download.cancels()).toBe(1);
  });

  /** A connection that fails and an answer that breaks off are no answer, and the error quotes nothing of their cause. */
  it('names a call whose connection fails, or whose answer breaks off, as no answer, quoting nothing of its cause', async () => {
    const refusing: typeof fetch = async () => {
      throw new TypeError('fetch failed: fake private words');
    };
    const breaksOff: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              controller.error(new TypeError('terminated: fake private words'));
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    for (const fetchImpl of [refusing, breaksOff]) {
      for (const call of everyCall(fetchImpl)) {
        const outcome = await within(call());
        expect(outcome).toBeInstanceOf(DriveNoAnswer);
        expect(outcome).toMatchObject({ reason: 'network', message: 'Drive gave no answer: network' });
      }
    }
    const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000, fetchImpl: refusing });
    expect(await within(connector.read(picked('fake-pdf')))).toMatchObject({ name: 'DriveNoAnswer', reason: 'network' });
  });

  /** A body past its cap is refused at once, its stream asked to cancel and never waited on, whether its length is declared or streamed. */
  it('refuses an answer past its cap at once, declared or streamed, even when its stream never finishes cancelling', async () => {
    for (const declared of [true, false]) {
      const calls: Array<[(fetchImpl: typeof fetch) => Promise<unknown>, number]> = [
        [(fetchImpl) => driveFile(TOKEN, 'fake-pdf', { fetchImpl }), 1_048_576],
        [(fetchImpl) => exportFile(TOKEN, 'fake-doc', 'text/markdown', 64, { fetchImpl }), 64],
        [(fetchImpl) => downloadFile(TOKEN, 'fake-pdf', 64, { fetchImpl }), 64],
        [(fetchImpl) => driveAccount(TOKEN, { fetchImpl }), 1_048_576],
      ];
      for (const [call, cap] of calls) {
        const over = pastCap(cap + 1, declared);
        expect(await within(call(over.fetchImpl))).toMatchObject({ name: 'ReadCapExceeded', maxBytes: cap });
        expect(over.cancels()).toBe(1);
      }
      // Through the connector: a download past maxFileBytes is answered too large, at once.
      const over = pastCap(65, declared);
      const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 64, fetchImpl: pdfWith(over.fetchImpl) });
      expect(await within(connector.read(picked('fake-pdf')))).toEqual({ id: 'fake-pdf', reason: 'too_large' });
      expect(over.cancels()).toBe(1);
    }
  });

  /** The connector's timeoutMs bounds each of its calls, and a call that gets no answer is thrown, never answered gone. */
  it("ends the connector's calls at its timeoutMs, throwing no answer rather than answering a file gone", async () => {
    const stalled = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000, fetchImpl: neverAnswers, timeoutMs: 50 });
    const selection = { ids: ['fake-pdf'] };
    for (const call of [() => stalled.read(picked('fake-pdf')), () => stalled.list(selection), () => stalled.changesSince(null, selection)]) {
      const outcome = await within(call());
      expect(outcome).toBeInstanceOf(DriveNoAnswer);
      expect(outcome).toMatchObject({ reason: 'timeout' });
    }
    // The metadata answered, and the download's answer stalls.
    const download = new GoogleDrivePickedConnector(async () => TOKEN, {
      ownedOnly: true,
      maxFileBytes: 1_000,
      fetchImpl: pdfWith(stallsInBody(200, '%PDF-1.7')),
      timeoutMs: 50,
    });
    expect(await within(download.read(picked('fake-pdf')))).toMatchObject({ name: 'DriveNoAnswer', reason: 'timeout' });
  });

  /** A call whose signal has already aborted is refused before any request. */
  it('refuses a call whose signal has already aborted before any request', async () => {
    let requests = 0;
    const counting: typeof fetch = async () => {
      requests += 1;
      return json(PDF_META);
    };
    for (const call of everyCall(counting, { signal: AbortSignal.abort() })) {
      const outcome = await within(call());
      expect(outcome).toBeInstanceOf(DriveNoAnswer);
      expect(outcome).toMatchObject({ reason: 'cancelled', message: 'Drive gave no answer: cancelled' });
    }
    expect(requests).toBe(0);
  });

  /** An aborted call answers alike whatever its inputs: no token is asked for and Drive is not called. */
  it("refuses the connector's calls whose signal has already aborted, before it checks its inputs, asks for a token or calls Drive", async () => {
    let tokens = 0;
    let requests = 0;
    const connector = new GoogleDrivePickedConnector(
      async () => {
        tokens += 1;
        return TOKEN;
      },
      {
        ownedOnly: true,
        maxFileBytes: 1_000,
        fetchImpl: async () => {
          requests += 1;
          return json(PDF_META);
        },
      },
    );
    const aborted = AbortSignal.abort();
    const calls = [
      () => connector.list({ ids: ['fake-pdf'] }, aborted),
      () => connector.list({ ids: [''] }, aborted),
      () => connector.read(picked('fake-pdf'), aborted),
      () => connector.read(picked('..'), aborted),
      () => connector.changesSince(null, { ids: ['fake-pdf'] }, aborted),
      () => connector.changesSince('not a cursor', { ids: ['fake-pdf'] }, aborted),
    ];
    for (const call of calls) {
      const outcome = await within(call());
      expect(outcome).toBeInstanceOf(DriveNoAnswer);
      expect(outcome).toMatchObject({ reason: 'cancelled', message: 'Drive gave no answer: cancelled' });
    }
    expect(tokens).toBe(0);
    expect(requests).toBe(0);
  });

  /** A timeout a timer cannot hold is refused before any request: Node runs a timer of 0, NaN, Infinity or past 2^31 - 1 ms after 1 ms. */
  it('refuses a timeoutMs that is not a whole number of milliseconds from 1 to 2,147,483,647, before any request', async () => {
    let requests = 0;
    const counting: typeof fetch = async () => {
      requests += 1;
      return json(PDF_META);
    };
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      for (const call of everyCall(counting, { timeoutMs })) {
        await expect(call()).rejects.toThrow(TypeError);
      }
      const connector = new GoogleDrivePickedConnector(async () => TOKEN, { ownedOnly: true, maxFileBytes: 1_000, fetchImpl: counting, timeoutMs });
      await expect(connector.read(picked('fake-pdf'))).rejects.toThrow(TypeError);
    }
    expect(requests).toBe(0);
  });
});
