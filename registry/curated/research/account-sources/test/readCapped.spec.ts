import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { ReadCapExceeded, readCapped } from '../src/index.js';

/** Makes a counted stream with no read ahead by its queue. */
function streamedResponse(totalBytes: number, chunkBytes: number, headers: Record<string, string> = {}, cancelError?: Error) {
  const seen = { bytes: 0, chunks: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    /** Emits one chunk only when the consumer asks for it. */
    pull(controller) {
      if (seen.bytes === totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - seen.bytes);
      seen.bytes += size;
      seen.chunks += 1;
      controller.enqueue(new Uint8Array(size).fill(65));
    },
    /** Records cancellation and optionally rejects the cleanup operation. */
    async cancel(): Promise<void> {
      seen.cancelled = true;
      if (cancelError !== undefined) throw cancelError;
    },
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), seen };
}

/** Exercises capped reads through real response bodies. */
describe('readCapped', () => {
  /** Stops a three megabyte stream at the first chunk past two megabytes. */
  it('refuses an oversized stream after at most one chunk past the cap', async () => {
    const { response, seen } = streamedResponse(3_000_000, 250_000);
    const reading = readCapped(response, 2_000_000);
    await expect(reading).rejects.toBeInstanceOf(ReadCapExceeded);
    await expect(reading).rejects.toMatchObject({ name: 'ReadCapExceeded', maxBytes: 2_000_000 });
    expect(seen.bytes).toBe(2_250_000);
    expect(seen.chunks).toBe(9);
    expect(seen.cancelled).toBe(true);
  });

  /** Joins all chunks of a one megabyte body without changing its bytes. */
  it('answers the bytes of a body below the cap', async () => {
    const { response, seen } = streamedResponse(1_000_000, 250_000);
    expect(await readCapped(response, 2_000_000)).toEqual(new Uint8Array(1_000_000).fill(65));
    expect(seen.bytes).toBe(1_000_000);
    expect(seen.cancelled).toBe(false);
  });

  /** Refuses an oversized declared length before requesting the first chunk. */
  it('refuses an oversized content-length before reading', async () => {
    const { response, seen } = streamedResponse(3_000_000, 250_000, { 'content-length': '3000000' });
    await expect(readCapped(response, 2_000_000)).rejects.toBeInstanceOf(ReadCapExceeded);
    expect(seen.bytes).toBe(0);
    expect(seen.chunks).toBe(0);
    expect(seen.cancelled).toBe(true);
  });

  /** Preserves the cap error when either cancellation path rejects. */
  it.each([false, true])('preserves the cap error when cancellation rejects with a declared length: %s', async (declared) => {
    const headers: Record<string, string> = declared ? { 'content-length': '8' } : {};
    const { response, seen } = streamedResponse(8, 4, headers, new Error('cancellation failed'));
    const reading = readCapped(response, 2);
    await expect(reading).rejects.toBeInstanceOf(ReadCapExceeded);
    await expect(reading).rejects.toMatchObject({ maxBytes: 2 });
    expect(seen.bytes).toBe(declared ? 0 : 4);
    expect(seen.cancelled).toBe(true);
  });

  /** Allows a body that reaches the cap exactly. */
  it('accepts exactly the cap', async () => {
    expect(await readCapped(new Response('abcd'), 4)).toEqual(new Uint8Array([97, 98, 99, 100]));
  });

  /** Returns no bytes for a response with no body. */
  it('reads an absent body as empty', async () => {
    expect(await readCapped(new Response(null), 0)).toEqual(new Uint8Array(0));
  });

  /** Ignores the representation length on a bodyless response such as HEAD. */
  it('reads an absent body as empty despite an oversized content-length', async () => {
    const response = new Response(null, { headers: { 'content-length': '3000000' } });
    expect(await readCapped(response, 2_000_000)).toEqual(new Uint8Array(0));
  });
});
