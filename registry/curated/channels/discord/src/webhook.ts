/**
 * @fileoverview A plain-text post to a Discord webhook: `POST <url>?wait=true` with `{ content, allowed_mentions: { parse: [] } }`,
 * so a 200 carries the created message and no user, role or everyone mention renders. The URL is a secret: it appears in no answer, no
 * error and no log line; every failure is a shaped answer, never a throw. No discord.js on this path.
 */
export interface WebhookSenderOptions {
  readonly url: string;
  readonly fetch?: typeof fetch;
  /** 5_000 by default. */
  readonly timeoutMs?: number;
  readonly logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}
export interface WebhookPost {
  readonly content: string;
  readonly allowedMentions?: 'none';
  /** A caller's signal (an outbox's claim deadline): an abort ends the post as `no_answer`, body included. */
  readonly signal?: AbortSignal;
}
export type WebhookAnswer =
  | { readonly outcome: 'sent'; readonly deliveryId: string }
  | { readonly outcome: 'retry'; readonly afterMs: number; readonly status: number }
  | { readonly outcome: 'failed'; readonly status: number | null; readonly kind: 'status' | 'no_answer' | 'refused' };

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

export function createWebhookSender(options: WebhookSenderOptions): { post(post: WebhookPost): Promise<WebhookAnswer> } {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const target = new URL(options.url);
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
        options.logger?.warn('discord_webhook', { outcome: 'no_answer' });
        return { outcome: 'failed', status: null, kind: 'no_answer' };
      };
      try {
        let response: Response;
        try {
          response = await doFetch(target.toString(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: post.content, allowed_mentions: { parse: [] } }),
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
        return { outcome: 'failed', status: response.status, kind: 'status' };
      } finally {
        clearTimeout(timer);
        post.signal?.removeEventListener('abort', onCallerAbort);
      }
    },
  };
}
