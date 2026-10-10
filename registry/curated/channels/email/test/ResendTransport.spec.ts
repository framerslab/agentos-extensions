import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('refuses a key that holds a control character before any request, and its error carries no part of the key', async () => {
    const error = await transport({ apiKey: 're_test_not_a\nreal_key' })
      .send(MESSAGE)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    const { message, cause } = error as Error & { cause?: unknown };
    expect(message).toBe('The Resend API key holds a control character');
    expect(`${message}\n${String(cause ?? '')}`).not.toMatch(/re_test_not_a|real_key/);
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
