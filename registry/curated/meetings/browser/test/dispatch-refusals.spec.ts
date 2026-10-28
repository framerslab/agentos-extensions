/**
 * Exact refusal words preserve the existing two-reason manager contract.
 *
 * @module
 */
import { afterEach, expect, it, vi } from 'vitest';
import { DispatchRefusedError, NoCapacityError, type DispatchInput } from '@framers/agentos/io/channels/meetings';
import { BrowserMeetingProvider } from '../src/BrowserMeetingProvider.js';

/** Disposable inputs, never a diagnostic vocabulary. */
const PRIVATE = ['spoken private words', 'Private Fixture Person', 'person@example.invalid', '203.0.113.7', 'sk_private_key'];
/** The complete existing dispatch contract. */
const input: DispatchInput = {
  run: { runId: 'fixture-run', ownerRef: 'fixture-owner', providerName: 'browser', platform: 'google_meet', state: 'in_call', keep: 'none', meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: PRIVATE[1], notice: { text: PRIVATE[0], version: '1', lateArrivalText: PRIVATE[0] }, stopPhrase: 'stop now', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, billedSeconds: 0, dispatch: { roomName: 'fixture-room', workerTokenHash: 'fixture-hash' } },
  room: { url: 'wss://room.invalid', name: 'fixture-room', publishToken: PRIVATE[4] },
  workerToken: 'fixture-worker-token', reportUrl: 'https://product.invalid/report',
};
/** Return the actual thrown error without accepting a resolved dispatch. */
async function refused(body: string, status = 409): Promise<Error> {
  const fetchImpl: typeof fetch = vi.fn(async () => new Response(body, { status }));
  const provider = new BrowserMeetingProvider({ schedulerUrl: 'https://scheduler.invalid', schedulerToken: 'fixture-client-token', workerId: 'fixture-worker', fetchImpl });
  let result: unknown;
  try { await provider.dispatch(input); } catch (error: unknown) { result = error; }
  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(result).toBeInstanceOf(Error);
  if (result instanceof Error) return result;
  throw new Error('dispatch did not refuse');
}

afterEach(() => { vi.restoreAllMocks(); });

it.each([['no identity', 'no_identity'], ['paused', 'paused']])('maps %s to a fixed permission refusal', async (body, word) => {
  const streams: string[] = [];
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    streams.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true;
  });
  const error = await refused(JSON.stringify({ error: body, detail: PRIVATE.join(' ') }));
  expect(error).toBeInstanceOf(DispatchRefusedError);
  expect(error).not.toBeInstanceOf(NoCapacityError);
  expect(error).toMatchObject({ name: 'DispatchRefusedError', reason: 'permission_denied', message: word });
  expect('cause' in error).toBe(false);
  expect(streams.join('')).toBe('');
  for (const marker of PRIVATE) expect((JSON.stringify(error) + error.message).includes(marker)).toBe(false);
});

it('keeps a real slot refusal as NoCapacityError and reads no arbitrary response text into it', async () => {
  const error = await refused(JSON.stringify({ error: 'no slot', detail: PRIVATE.join(' ') }));
  expect(error).toBeInstanceOf(NoCapacityError);
  expect(error).toMatchObject({ reason: 'no_capacity', message: 'no worker has a free slot' });
});

it.each(['', '{', 'null', '[]', '42', '"paused"', '{}', '{"error":{}}', '{"error":"PAUSED"}', '{"error":"no identity "}', JSON.stringify({ error: PRIVATE.join(' ') })])('keeps an unread or unknown refusal transient with a fixed message', async (body) => {
  const error = await refused(body);
  expect(error).not.toBeInstanceOf(DispatchRefusedError);
  expect(error.message).toBe('scheduler refused the run: 409');
  expect('cause' in error).toBe(false);
  for (const marker of PRIVATE) expect((JSON.stringify(error) + error.message).includes(marker)).toBe(false);
});

it('keeps other HTTP failures on the existing transient path', async () => {
  const error = await refused(PRIVATE.join(' '), 503);
  expect(error).not.toBeInstanceOf(DispatchRefusedError);
  expect(error.message).toBe('scheduler refused the run: 503');
});
