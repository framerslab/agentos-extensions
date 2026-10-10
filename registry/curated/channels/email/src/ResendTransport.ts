/**
 * @fileoverview A transport for Resend's HTTPS API: one `POST /emails` a message, the API key as the bearer, an
 * `Idempotency-Key` when the caller gives one, the text and the HTML part in one call, and Resend's own retry terms
 * inside one deadline. A refusal keeps the status and Resend's error name, never its message, which can quote an
 * address.
 */

/** Resend's API origin. */
const RESEND_API = 'https://api.resend.com';

/** The `User-Agent` sent when the caller names none: Resend refuses a request without one. */
const DEFAULT_USER_AGENT = 'agentos-ext-channel-email';

/** The longest one send may take when the caller names no deadline, retries and their waits included. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** The retries one send makes at most when the caller names no number. */
const DEFAULT_MAX_RETRIES = 2;

/** The shape of an error name Resend gives, such as `validation_error`; any other value is read as `unknown`. */
const ERROR_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * A control character, U+0000 to U+001F or U+007F to U+009F. No API key holds one, and a NUL, CR or LF inside a header
 * value makes `Headers` throw a `TypeError` whose message quotes the whole value, key and all.
 */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** What the transport needs: the key, and where and as what it calls. */
export interface ResendOptions {
  /**
   * The API key, or a function that answers it at each send (a key file read when a message goes out). Whitespace around
   * it, such as a key file's final line break, is trimmed.
   */
  apiKey: string | (() => string);
  /** The API's origin with no trailing slash; Resend's own when unset. */
  baseUrl?: string;
  /** The `User-Agent` every request carries, which Resend requires; the pack's name when unset. */
  userAgent?: string;
  /** The longest one send may take, its retries and their waits included; fifteen seconds when unset. */
  timeoutMs?: number;
  /** The most retries one send makes; two when unset. */
  maxRetries?: number;
}

/** One file sent with a message: its content (Base64 on the wire) or the address it is hosted at. */
export interface OutgoingAttachment {
  filename: string;
  content?: string | Buffer;
  path?: string;
  contentType?: string;
}

/** One message as the transport sends it. */
export interface OutgoingEmail {
  /** The From header; a display name is allowed, as in "Example <hello@example.com>". */
  from: string;
  /** The one recipient. */
  to: string;
  subject: string;
  /** The plain-text part. */
  text: string;
  /** The HTML part, sent in the same call. */
  html?: string;
  replyTo?: string;
  cc?: string;
  bcc?: string;
  /** Headers added to the message, such as `In-Reply-To` and `References` for a reply. */
  headers?: Record<string, string>;
  /**
   * Resend's `Idempotency-Key`: a second request under the same key within 24 hours delivers nothing more. At most 256
   * characters, and never personal data.
   */
  idempotencyKey?: string;
  attachments?: OutgoingAttachment[];
}

/** A send Resend answered outside 2xx: its status, Resend's error name (`unknown` when it named none) and the wait it asked for. */
export class EmailApiError extends Error {
  /** The type's own name. */
  override name = 'EmailApiError';

  /** The HTTP status Resend answered with. */
  readonly status: number;

  /** Resend's error name, such as `rate_limit_exceeded`, or `unknown`. */
  readonly type: string;

  /** The seconds the answer's `retry-after` header asked for, or null. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, type: string, retryAfterSeconds: number | null) {
    super(`Resend refused the email with ${status} ${type}`);
    this.status = status;
    this.type = type;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The wait before the next try, in seconds, or null when the refusal is not tried again: a rate limit always (it was
 * refused before anything was sent), and under an idempotency key a 409 `concurrent_idempotent_requests` and any 5xx,
 * which Resend's errors page answers with "Try the request again later"; never a quota, a validation error or
 * `invalid_idempotent_request`. The wait is the answer's `retry-after`, else one second, then two.
 */
export function retryWaitSeconds(error: EmailApiError, keyed: boolean, retry: number): number | null {
  const tryAgain = error.type === 'rate_limit_exceeded' || (keyed && (error.type === 'concurrent_idempotent_requests' || error.status >= 500));
  return tryAgain ? (error.retryAfterSeconds ?? retry) : null;
}

/** The answer's `retry-after` in seconds, or null when it is absent or not a number of seconds. */
function retryAfterOf(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null || raw.trim() === '') return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** A refusal read from Resend's answer: the status, the error's name when it is a word, the wait; the rest dropped. */
async function refusalOf(answer: Response): Promise<EmailApiError> {
  let type = 'unknown';
  try {
    const body: unknown = await answer.json();
    const name = typeof body === 'object' && body !== null && 'name' in body ? (body as { name: unknown }).name : undefined;
    if (typeof name === 'string' && ERROR_NAME.test(name)) type = name;
  } catch {
    // not JSON: the name stays unknown
  }
  return new EmailApiError(answer.status, type, retryAfterOf(answer.headers));
}

/**
 * The message's id from a 2xx answer, or the empty string when the answer's body names none or cannot be read (not
 * JSON, no `id`, or cut off by the deadline). A 2xx means Resend took the email, so the send still succeeds: a failure
 * reported here would lead a caller to send the email a second time.
 */
async function messageIdOf(answer: Response): Promise<string> {
  try {
    const body: unknown = await answer.json();
    const id = typeof body === 'object' && body !== null && 'id' in body ? (body as { id: unknown }).id : undefined;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

/** One attachment in Resend's shape. */
function attachmentOf(attachment: OutgoingAttachment): Record<string, string> {
  const shaped: Record<string, string> = { filename: attachment.filename };
  if (attachment.content !== undefined) {
    shaped.content = (typeof attachment.content === 'string' ? Buffer.from(attachment.content) : attachment.content).toString('base64');
  }
  if (attachment.path !== undefined) shaped.path = attachment.path;
  if (attachment.contentType !== undefined) shaped.content_type = attachment.contentType;
  return shaped;
}

/** The request's JSON body: the fields Resend's send call names, and only those the message carries. */
function bodyOf(message: OutgoingEmail): Record<string, unknown> {
  const body: Record<string, unknown> = { from: message.from, to: [message.to], subject: message.subject, text: message.text };
  if (message.html !== undefined) body.html = message.html;
  if (message.replyTo !== undefined) body.reply_to = message.replyTo;
  if (message.cc !== undefined) body.cc = message.cc;
  if (message.bcc !== undefined) body.bcc = message.bcc;
  if (message.headers !== undefined) body.headers = message.headers;
  if (message.attachments !== undefined && message.attachments.length > 0) body.attachments = message.attachments.map(attachmentOf);
  return body;
}

/** Resend's send call. */
export class ResendTransport {
  private readonly options: ResendOptions;

  constructor(options: ResendOptions) {
    this.options = options;
  }

  /**
   * Sends one message: the key read once and trimmed, then `POST /emails`, tried again on Resend's terms while the
   * deadline allows. Throws an `Error` before any request when the key holds a control character, with a message that
   * names no part of the key; `EmailApiError` for a refusal; and what `fetch` throws for a connection that fails
   * (`TypeError`) or the deadline (`TimeoutError`), so a caller can tell them apart. A 2xx answer always resolves, since
   * Resend has taken the email: its `messageId` is the empty string when the answer names no id or its body cannot be
   * read before the deadline.
   */
  async send(message: OutgoingEmail): Promise<{ messageId: string }> {
    // String() keeps the coercion a template literal gave a key answered outside TypeScript, such as a Buffer.
    const key = String(typeof this.options.apiKey === 'function' ? this.options.apiKey() : this.options.apiKey).trim();
    if (CONTROL_CHARACTER.test(key)) throw new Error('The Resend API key holds a control character');
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = this.options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const deadline = Date.now() + timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const headers = new Headers({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': this.options.userAgent ?? DEFAULT_USER_AGENT });
    if (message.idempotencyKey !== undefined) headers.set('Idempotency-Key', message.idempotencyKey);
    const body = JSON.stringify(bodyOf(message));
    const url = `${(this.options.baseUrl ?? RESEND_API).replace(/\/+$/, '')}/emails`;
    for (let retry = 0; ; retry += 1) {
      const answer = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal });
      if (answer.ok) return { messageId: await messageIdOf(answer) };
      const error = await refusalOf(answer);
      const wait = retry < maxRetries ? retryWaitSeconds(error, message.idempotencyKey !== undefined, retry + 1) : null;
      if (wait === null || Date.now() + wait * 1000 >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
  }
}
