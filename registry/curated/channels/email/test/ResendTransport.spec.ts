import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmailApiError, ResendTransport, type ResendOptions } from '../src/ResendTransport';
import { startResendStandIn, type ResendStandIn } from './stand-in';

const KEY = 're_test_not_a_real_key';
const MESSAGE = { from: 'Example <hello@example.com>', to: 'reader@example.com', subject: 'Hello', text: 'Plain words.' };

let standIn: ResendStandIn;

beforeEach(async () => {
  standIn = await startResendStandIn();
});

afterEach(async () => {
  await standIn.close();
});

/** A transport on the stand-in, with the options a case changes. */
function transport(extra: Partial<ResendOptions> = {}): ResendTransport {
  return new ResendTransport({ apiKey: KEY, baseUrl: standIn.url, userAgent: 'example-app/1.0', ...extra });
}

/** The refusal a send ends in, checked to be the transport's own error. */
async function refusal(sending: Promise<unknown>): Promise<EmailApiError> {
  const error = await sending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(EmailApiError);
  return error as EmailApiError;
}

/** Resend's error body. */
function refused(statusCode: number, name: string): { statusCode: number; name: string; message: string } {
  return { statusCode, name, message: 'A message the transport never keeps.' };
}

describe('ResendTransport', () => {
  it('sends one POST /emails with the bearer key, the From, one recipient in an array, the subject, both parts, the reply-to and the key', async () => {
    const result = await transport().send({ ...MESSAGE, html: '<p>Plain words.</p>', replyTo: 'team@example.com', idempotencyKey: 'example-1' });
    expect(result).toEqual({ messageId: 'email_1' });
    expect(standIn.received).toEqual([
      {
        authorization: `Bearer ${KEY}`,
        idempotencyKey: 'example-1',
        userAgent: 'example-app/1.0',
        contentType: 'application/json',
        body: { from: 'Example <hello@example.com>', to: ['reader@example.com'], subject: 'Hello', text: 'Plain words.', html: '<p>Plain words.</p>', reply_to: 'team@example.com' },
      },
    ]);
  });

  it('sends no idempotency header and no field a message does not carry', async () => {
    await transport().send(MESSAGE);
    expect(standIn.received[0]?.idempotencyKey).toBeUndefined();
    expect(standIn.received[0]?.body).toEqual({ from: MESSAGE.from, to: [MESSAGE.to], subject: 'Hello', text: 'Plain words.' });
  });

  it("sends the pack's name as the User-Agent when the caller names none", async () => {
    await new ResendTransport({ apiKey: KEY, baseUrl: standIn.url }).send(MESSAGE);
    expect(standIn.received[0]?.userAgent).toBe('agentos-ext-channel-email');
  });

  it('reads a key given as a function once at each send', async () => {
    let reads = 0;
    const keyed = transport({
      apiKey: () => {
        reads += 1;
        return `re_test_key_${reads}`;
      },
    });
    await keyed.send(MESSAGE);
    await keyed.send(MESSAGE);
    expect(standIn.received.map((request) => request.authorization)).toEqual(['Bearer re_test_key_1', 'Bearer re_test_key_2']);
  });

  it("trims the key it reads, so a stray space or a key file's final line break never reaches the header", async () => {
    await transport({ apiKey: () => ` ${KEY}\r\n` }).send(MESSAGE);
    expect(standIn.received[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([
    ['a line break', 're_test_not_a\nreal_key'],
    ['a DEL', 're_test_not_a\u007freal_key'],
    ['a character above U+00FF', 're_test_not_a\u2713real_key'],
  ])('refuses a key that holds %s before any request, and its error carries no part of the key', async (_what, key) => {
    const error = await transport({ apiKey: key })
      .send(MESSAGE)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    const { message, cause } = error as Error & { cause?: unknown };
    expect(message).toBe('The Resend API key holds a character an HTTP header cannot carry');
    expect(`${message}\n${String(cause ?? '')}`).not.toMatch(/re_test_not_a|real_key/);
    expect(standIn.received).toHaveLength(0);
  });

  it('refuses an idempotency key or a User-Agent that holds a character a header cannot carry, before any request', async () => {
    const caught = (sending: Promise<unknown>): Promise<unknown> =>
      sending.then(
        () => undefined,
        (error: unknown) => error,
      );
    const keyed = await caught(transport().send({ ...MESSAGE, idempotencyKey: 'example-\r\n7' }));
    const agent = await caught(transport({ userAgent: 'example-app/\u2713' }).send(MESSAGE));
    expect(keyed).not.toBeInstanceOf(TypeError);
    expect(agent).not.toBeInstanceOf(TypeError);
    expect([(keyed as Error).message, (agent as Error).message]).toEqual([
      'The idempotency key holds a character an HTTP header cannot carry',
      'The User-Agent holds a character an HTTP header cannot carry',
    ]);
    expect(standIn.received).toHaveLength(0);
  });

  it('sends an attachment as Base64 with its name and type, and one by address as its path', async () => {
    await transport().send({
      ...MESSAGE,
      attachments: [
        { filename: 'a.txt', content: 'hi', contentType: 'text/plain' },
        { filename: 'b.pdf', path: 'https://example.com/b.pdf' },
      ],
    });
    expect(standIn.received[0]?.body.attachments).toEqual([
      { filename: 'a.txt', content: Buffer.from('hi').toString('base64'), content_type: 'text/plain' },
      { filename: 'b.pdf', path: 'https://example.com/b.pdf' },
    ]);
  });

  it('reads a file on this host and a data: address into Base64 content, as SMTP does, and keeps an https path for Resend', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'resend-attachment-'));
    try {
      const file = join(folder, 'notes.txt');
      await writeFile(file, 'Local words.');
      await transport().send({
        ...MESSAGE,
        attachments: [
          { filename: 'notes.txt', path: file },
          { filename: 'hi.txt', path: 'data:text/plain;base64,aGk=' },
          { filename: 'b.pdf', path: 'https://example.com/b.pdf' },
          { filename: 'given.txt', content: 'Given words.', path: file },
        ],
      });
      expect(standIn.received[0]?.body.attachments).toEqual([
        { filename: 'notes.txt', content: Buffer.from('Local words.').toString('base64') },
        { filename: 'hi.txt', content: Buffer.from('hi').toString('base64'), content_type: 'text/plain' },
        { filename: 'b.pdf', path: 'https://example.com/b.pdf' },
        { filename: 'given.txt', content: Buffer.from('Given words.').toString('base64') },
      ]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('throws the read error before any request when an attachment names a file that is not there', async () => {
    const missing = join(tmpdir(), 'resend-attachment-missing', 'gone.txt');
    const error = await transport()
      .send({ ...MESSAGE, attachments: [{ filename: 'gone.txt', path: missing }] })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(standIn.received).toHaveLength(0);
  });

  it("throws EmailApiError with the status and Resend's error name, keeps no message, and does not retry a validation error", async () => {
    standIn.queue({ status: 422, body: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field: secret@example.com' } });
    const error = await refusal(transport().send({ ...MESSAGE, idempotencyKey: 'example-2' }));
    expect([error.name, error.status, error.type, error.retryAfterSeconds]).toEqual(['EmailApiError', 422, 'validation_error', null]);
    expect(error.message).not.toContain('secret@example.com');
    expect(standIn.received).toHaveLength(1);
  });

  it('reads a refusal with no JSON body as unknown', async () => {
    standIn.queue({ status: 502, body: 'Bad gateway' });
    const error = await refusal(transport().send(MESSAGE));
    expect([error.status, error.type]).toEqual([502, 'unknown']);
    expect(standIn.received).toHaveLength(1);
  });

  it('resolves a 2xx whose body cannot be read with an empty messageId, never an error, since the email was sent', async () => {
    standIn.queue({ status: 200, body: 'Accepted' });
    expect(await transport().send(MESSAGE)).toEqual({ messageId: '' });
    standIn.queue({ status: 200, body: { id: 'email_late' }, bodyDelayMs: 2_000 });
    expect(await transport({ timeoutMs: 500 }).send({ ...MESSAGE, idempotencyKey: 'example-6' })).toEqual({ messageId: '' });
    expect(standIn.received).toHaveLength(2);
  });

  it('waits the retry-after a rate limit names, then sends once more', async () => {
    standIn.queue({ status: 429, body: refused(429, 'rate_limit_exceeded'), headers: { 'retry-after': '1' } });
    const started = Date.now();
    expect((await transport().send(MESSAGE)).messageId).toBe('email_1');
    expect(standIn.received).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it.each(['daily_quota_exceeded', 'monthly_quota_exceeded'])('never retries %s, a 429 that seconds do not clear', async (name) => {
    standIn.queue({ status: 429, body: refused(429, name), headers: { 'retry-after': '1' } });
    const error = await refusal(transport().send({ ...MESSAGE, idempotencyKey: 'example-3' }));
    expect([error.status, error.type]).toEqual([429, name]);
    expect(standIn.received).toHaveLength(1);
  });

  it(
    'retries a 500 and a 503 under an idempotency key, one second and then two apart, and never without a key',
    async () => {
      standIn.queue({ status: 500, body: refused(500, 'application_error') });
      standIn.queue({ status: 503, body: refused(503, 'service_unavailable') });
      const started = Date.now();
      expect((await transport().send({ ...MESSAGE, idempotencyKey: 'example-4' })).messageId).toBe('email_1');
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
      expect(standIn.received.map((request) => request.idempotencyKey)).toEqual(['example-4', 'example-4', 'example-4']);
      standIn.queue({ status: 500, body: refused(500, 'application_error') });
      const error = await refusal(transport().send(MESSAGE));
      expect(error.type).toBe('application_error');
      expect(standIn.received).toHaveLength(4);
    },
    10_000,
  );

  it('retries concurrent_idempotent_requests and never invalid_idempotent_request', async () => {
    standIn.queue({ status: 409, body: refused(409, 'concurrent_idempotent_requests') });
    expect((await transport().send({ ...MESSAGE, idempotencyKey: 'example-5' })).messageId).toBe('email_1');
    expect(standIn.received).toHaveLength(2);
    standIn.queue({ status: 409, body: refused(409, 'invalid_idempotent_request') });
    const error = await refusal(transport().send({ ...MESSAGE, text: 'Other words.', idempotencyKey: 'example-5' }));
    expect(error.type).toBe('invalid_idempotent_request');
    expect(standIn.received).toHaveLength(3);
  });

  it('stops after two retries', async () => {
    for (let i = 0; i < 3; i += 1) standIn.queue({ status: 429, body: refused(429, 'rate_limit_exceeded'), headers: { 'retry-after': '0' } });
    const error = await refusal(transport().send(MESSAGE));
    expect(error.type).toBe('rate_limit_exceeded');
    expect(standIn.received).toHaveLength(3);
  });

  it('takes no wait that would pass the deadline and throws the refusal at once', async () => {
    standIn.queue({ status: 429, body: refused(429, 'rate_limit_exceeded'), headers: { 'retry-after': '5' } });
    const started = Date.now();
    const error = await refusal(transport({ timeoutMs: 1_000 }).send(MESSAGE));
    expect([error.type, error.retryAfterSeconds]).toEqual(['rate_limit_exceeded', 5]);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("throws fetch's own TimeoutError when the answer comes after the deadline", async () => {
    standIn.queue({ delayMs: 3_000 });
    const error = await transport({ timeoutMs: 200 })
      .send(MESSAGE)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect((error as Error).name).toBe('TimeoutError');
  });
});
