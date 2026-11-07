/**
 * @fileoverview A plain-text post to a Discord webhook: `POST <url>?wait=true` with `{ content, allowed_mentions: { parse: [] } }`,
 * so a 200 carries the created message and Discord parses no user, role or everyone mention. The URL is a secret: it appears in no answer,
 * no error and no log line; every failure of a post is a shaped answer, never a throw. No discord.js on this path.
 */
/** What {@link createWebhookSender} is built from. */
export interface WebhookSenderOptions {
  /** The webhook's URL, `https://discord.com/api/webhooks/<id>/<token>`. It carries the token, so it is a secret and is never logged. */
  readonly url: string;
  /** The fetch to post with; `globalThis.fetch` by default. */
  readonly fetch?: typeof fetch;
  /** The one deadline for a post, the body's read included: 5_000 by default. */
  readonly timeoutMs?: number;
  /** Takes the one line the sender writes, `discord_webhook` with `{ outcome: 'no_answer' }`; a logger that throws changes no answer. */
  readonly logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}
/** One post: plain text, sent with every mention suppressed. */
export interface WebhookPost {
  /** The message's text, 1 to {@link WEBHOOK_CONTENT_MAX} characters; anything else is refused before any request. */
  readonly content: string;
  /** The one value there is: every post goes with `allowed_mentions: { parse: [] }`, whatever this says. */
  readonly allowedMentions?: 'none';
  /** A caller's signal (an outbox's claim deadline): an abort ends the post as `no_answer`, body included. */
  readonly signal?: AbortSignal;
}
/**
 * What a post comes to. `sent` carries the created message's id. `retry` carries the wait before the caller posts again: a 429's
 * `retry_after`, else its `Retry-After` header, else 30 s; 5 s for a 2xx that carries no message, since that post is unconfirmed.
 * `failed` is any other status, a redirect included (`status`), the deadline, the caller's abort or no connection (`no_answer`),
 * or content refused before any request (`refused`).
 */
export type WebhookAnswer =
  | { readonly outcome: 'sent'; readonly deliveryId: string }
  | { readonly outcome: 'retry'; readonly afterMs: number; readonly status: number }
  | { readonly outcome: 'failed'; readonly status: number | null; readonly kind: 'status' | 'no_answer' | 'refused' };

/** The most characters a post's `content` may hold, Discord's limit for a webhook message's content. */
export const WEBHOOK_CONTENT_MAX = 2_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_429_WAIT_MS = 30_000;
const UNCONFIRMED_WAIT_MS = 5_000;

async function retryAfterMs(response: Response): Promise<number> {
  const text = await response.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { retry_after?: unknown };
    if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after) && body.retry_after >= 0) return Math.round(body.retry_after * 1_000);
  } catch { /* not JSON */ }
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header >= 0 && response.headers.get('retry-after') !== null) return Math.round(header * 1_000);
  return DEFAULT_429_WAIT_MS;
}

/** The webhook's URL, or a TypeError that leaves it out: Node's own error keeps the input in its `input` property, which a logger prints. */
function webhookUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new TypeError('createWebhookSender: the url option is not a valid URL');
  }
}

/**
 * Builds a sender for one webhook. Its `post` sends `POST <url>?wait=true` once, follows no redirect, and resolves to a
 * {@link WebhookAnswer}; it never throws and never rejects. Retrying is the caller's. Throws a TypeError, which leaves the URL out,
 * when `url` does not parse.
 */
export function createWebhookSender(options: WebhookSenderOptions): { post(post: WebhookPost): Promise<WebhookAnswer> } {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const target = webhookUrl(options.url);
  target.searchParams.set('wait', 'true');
  return {
    async post(post) {
      if (typeof post.content !== 'string' || post.content.length === 0 || post.content.length > WEBHOOK_CONTENT_MAX) {
        return { outcome: 'failed', status: null, kind: 'refused' };
      }
      // One deadline for the whole exchange, the body's read included: the timer is cleared only once the answer is read,
      // so headers that arrive at once over a body that never ends still end within `timeoutMs`. The caller's signal joins it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onCallerAbort = () => controller.abort();
      post.signal?.addEventListener('abort', onCallerAbort, { once: true });
      if (post.signal?.aborted) controller.abort();
      const noAnswer = (): WebhookAnswer => {
        try {
          options.logger?.warn('discord_webhook', { outcome: 'no_answer' });
        } catch {
          // A logger's failure is the host's to see; the answer stays the one the exchange came to.
        }
        return { outcome: 'failed', status: null, kind: 'no_answer' };
      };
      try {
        let response: Response;
        try {
          response = await doFetch(target.toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: post.content, allowed_mentions: { parse: [] } }),
            // No redirect is followed: a followed 301 or 302 turns the POST into a GET with no body, and a GET of the webhook's URL
            // answers the webhook object, whose id would read as a sent message. A 3xx answers `failed` with its status.
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch {
          return noAnswer();
        }
        if (response.status === 429) {
          const afterMs = await retryAfterMs(response); // its text read swallows a rejection; the signal says whether the deadline cut it
          if (controller.signal.aborted) return noAnswer();
          return { outcome: 'retry', afterMs, status: 429 };
        }
        if (response.ok) {
          let body: { id?: unknown } | null = null;
          try { body = (await response.json()) as { id?: unknown }; } catch { body = null; }
          if (controller.signal.aborted) return noAnswer();
          if (body !== null && typeof body.id === 'string' && body.id !== '') return { outcome: 'sent', deliveryId: body.id };
          return { outcome: 'retry', afterMs: UNCONFIRMED_WAIT_MS, status: response.status };
        }
        // The body is not read: end the request, so an error body that never ends holds no connection past the answer.
        controller.abort();
        return { outcome: 'failed', status: response.status, kind: 'status' };
      } finally {
        clearTimeout(timer);
        post.signal?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}
