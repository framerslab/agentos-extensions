// @ts-nocheck
/**
 * A stand-in Telegram Bot API server on a local port, for tests that run the
 * pack's real grammY client over HTTP (the pack's `apiRoot` option points at it).
 *
 * It answers `getMe`, `deleteWebhook`, `sendMessage` and the rest the way the
 * Bot API does, holds each long poll (`getUpdates` with a `timeout`) open until a
 * test ends it, and answers every call with Telegram's 401 once the token is
 * revoked. It records each call's method and payload, never the token in the URL.
 */

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface FakeTelegram {
  /** The value for the pack's `apiRoot` option. */
  apiRoot: string;
  /** Every call the server received, in order. */
  calls: FakeTelegramCall[];
  /** How many long polls (getUpdates with a timeout) the server received. */
  polls(): number;
  /** How many long polls are open now, waiting for updates. */
  openPolls(): number;
  /**
   * Telegram stops accepting the token: every call from now on gets a 401. With
   * `answerOpenPolls` (the default), an open long poll gets the 401 too.
   */
  revoke(options?: { answerOpenPolls?: boolean }): void;
  /** Ends the open long polls with a server error (500) or a dropped connection. */
  failOpenPolls(kind: 'server_error' | 'network'): void;
  close(): Promise<void>;
}

const BOT_INFO = {
  id: 7,
  is_bot: true,
  first_name: 'Test',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function answer(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function unauthorized(res: ServerResponse): void {
  answer(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
}

export async function startFakeTelegram(): Promise<FakeTelegram> {
  const calls: FakeTelegramCall[] = [];
  const open = new Set<ServerResponse>();
  let tokenAccepted = true;

  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      // grammY calls `${apiRoot}/bot<token>/<method>`.
      const method = /\/bot[^/]+\/(\w+)$/.exec(req.url ?? '')?.[1] ?? '';
      let payload: Record<string, unknown> = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }
      calls.push({ method, payload });

      if (!tokenAccepted) return unauthorized(res);
      if (method === 'getMe') return answer(res, 200, { ok: true, result: BOT_INFO });
      if (method === 'getUpdates') {
        // The call grammY makes on stop() to confirm the offset carries no timeout.
        if (payload.timeout === undefined) return answer(res, 200, { ok: true, result: [] });
        open.add(res);
        res.on('close', () => open.delete(res));
        return undefined;
      }
      if (method === 'sendMessage') {
        return answer(res, 200, {
          ok: true,
          result: {
            message_id: 1,
            date: 1,
            chat: { id: Number(payload.chat_id), type: 'private', first_name: 'Ada' },
            text: payload.text,
          },
        });
      }
      return answer(res, 200, { ok: true, result: true });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    polls: () => calls.filter((c) => c.method === 'getUpdates' && c.payload.timeout !== undefined).length,
    openPolls: () => open.size,
    revoke({ answerOpenPolls = true } = {}) {
      tokenAccepted = false;
      if (answerOpenPolls) for (const res of [...open]) unauthorized(res);
    },
    failOpenPolls(kind) {
      for (const res of [...open]) {
        if (kind === 'network') res.socket?.destroy();
        else answer(res, 500, { ok: false, error_code: 500, description: 'Internal Server Error' });
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
