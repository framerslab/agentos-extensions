// @ts-nocheck
/**
 * A stand-in Discord on a local port, for tests that run the pack's real
 * discord.js client: the REST API under `/api` and a gateway WebSocket that
 * answers HELLO, IDENTIFY and heartbeats with a session that has no guilds.
 *
 * A test points discord.js's REST client at `restApi`; the gateway's address
 * reaches the client in the `GET /gateway/bot` answer, as Discord's does. Each
 * REST route's answer can be set to `ok`, a status code, or `network` (the
 * connection is dropped). The server records each request's method, path and
 * whether it carried an Authorization header, never the header's value.
 *
 * The WebSocket side implements the parts of RFC 6455 the client uses: the
 * opening handshake, unfragmented text frames, ping, and the closing handshake.
 */

import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type RouteAnswer = 'ok' | 'network' | 401 | 500;

export interface FakeDiscordRequest {
  method: string;
  path: string;
  authorized: boolean;
}

export interface FakeDiscord {
  /** The value for discord.js's `rest.api` option. */
  restApi: string;
  requests: FakeDiscordRequest[];
  /** How many requests matched `method` and a path ending in `pathSuffix`. */
  count(method: string, pathSuffix: string | RegExp): number;
  /** How many IDENTIFY payloads the gateway received. */
  identifies(): number;
  /** How many gateway connections are open. */
  openGatewayConnections(): number;
  /** The answer of `GET /gateway/bot`. Default `ok`. */
  gatewayBot: RouteAnswer;
  /** The answer of `GET /applications/:id/commands`. Default `ok` (no commands). */
  commands: RouteAnswer;
  /** The answer of `GET /channels/:id`. Default `ok` (a DM channel). */
  channel: RouteAnswer;
  /** The answer of `GET /guilds/:id`. Default `ok`, which answers 404 Unknown Guild. */
  guild: RouteAnswer;
  /**
   * The answer of `POST /interactions/:id/:token/callback`, a route discord.js
   * calls with the interaction's token rather than the bot token. Default `ok` (204).
   */
  interactionCallback: RouteAnswer;
  /** Closes every open gateway connection with `code`, as Discord closes a session. */
  closeGateway(code: number, reason?: string): void;
  close(): Promise<void>;
}

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const BOT_USER_ID = '100000000000000001';
export const APPLICATION_ID = '100000000000000002';

/** A server-to-client frame: final, unmasked. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Reads the complete client frames (masked) at the front of `buffer`. */
function readFrames(buffer: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let position = offset + 2;
    if (length === 126) {
      if (buffer.length < position + 2) break;
      length = buffer.readUInt16BE(position);
      position += 2;
    } else if (length === 127) {
      if (buffer.length < position + 8) break;
      length = Number(buffer.readBigUInt64BE(position));
      position += 8;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length < position + maskLength + length) break;
    const mask = masked ? buffer.subarray(position, position + 4) : null;
    position += maskLength;
    const payload = Buffer.from(buffer.subarray(position, position + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    offset = position + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 500: 'Internal Server Error' };

export async function startFakeDiscord(): Promise<FakeDiscord> {
  const requests: FakeDiscordRequest[] = [];
  const gatewaySockets = new Map<Socket, { closing: boolean }>();
  let identifyCount = 0;
  let gatewayUrl = '';

  const fake = {
    gatewayBot: 'ok' as RouteAnswer,
    commands: 'ok' as RouteAnswer,
    channel: 'ok' as RouteAnswer,
    guild: 'ok' as RouteAnswer,
    interactionCallback: 'ok' as RouteAnswer,
  };

  /** Answers a REST route as set, or with `ok` from `okBody`. */
  function route(res: ServerResponse, answer: RouteAnswer, okBody: () => unknown): void {
    if (answer === 'network') {
      res.socket?.destroy();
      return;
    }
    if (answer === 'ok') {
      json(res, 200, okBody());
      return;
    }
    json(res, answer, { message: `${answer}: ${STATUS_TEXT[answer] ?? 'Error'}`, code: 0 });
  }

  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method ?? 'GET';
      requests.push({ method, path, authorized: typeof req.headers.authorization === 'string' });

      if (method === 'GET' && /\/gateway\/bot$/.test(path)) {
        return route(res, fake.gatewayBot, () => ({
          url: gatewayUrl,
          shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 86_400_000, max_concurrency: 1 },
        }));
      }
      if (method === 'GET' && /\/applications\/\d+\/commands$/.test(path)) {
        return route(res, fake.commands, () => []);
      }
      const channel = /\/channels\/(\d+)$/.exec(path);
      if (method === 'GET' && channel) {
        return route(res, fake.channel, () => ({
          id: channel[1],
          type: 1,
          last_message_id: null,
          recipients: [{ id: '100000000000000003', username: 'ada', discriminator: '0', global_name: null, avatar: null }],
        }));
      }
      if (method === 'GET' && /\/guilds\/\d+$/.test(path)) {
        if (fake.guild === 'ok') return json(res, 404, { message: 'Unknown Guild', code: 10004 });
        return route(res, fake.guild, () => ({}));
      }
      if (method === 'POST' && /\/interactions\/\d+\/[^/]+\/callback$/.test(path)) {
        if (fake.interactionCallback === 'ok') {
          res.writeHead(204);
          res.end();
          return undefined;
        }
        return route(res, fake.interactionCallback, () => ({}));
      }
      json(res, 404, { message: '404: Not Found', code: 0 });
    });
  });

  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
    socket.write(
      ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'),
    );
    const state = { closing: false };
    gatewaySockets.set(socket, state);
    socket.on('close', () => gatewaySockets.delete(socket));
    socket.on('error', () => { /* the client went away */ });

    const send = (payload: unknown) => {
      if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(payload))));
    };

    send({ op: 10, d: { heartbeat_interval: 41_250 }, s: null, t: null });

    let pending: Buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      for (const { opcode, payload } of frames) {
        if (opcode === 0x8) {
          // The closing handshake: answer a close the client began, then end.
          if (!state.closing) socket.write(frame(0x8, payload.subarray(0, 2)));
          socket.end();
          return;
        }
        if (opcode === 0x9) {
          socket.write(frame(0xa, payload));
          continue;
        }
        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString('utf8'));
        if (message.op === 1) send({ op: 11 });
        if (message.op === 2) {
          identifyCount++;
          send({
            op: 0,
            s: 1,
            t: 'READY',
            d: {
              v: 10,
              user: { id: BOT_USER_ID, username: 'test-bot', discriminator: '0', global_name: null, avatar: null, bot: true, flags: 0 },
              guilds: [],
              session_id: 'session-1',
              resume_gateway_url: gatewayUrl,
              shard: [0, 1],
              application: { id: APPLICATION_ID, flags: 0 },
            },
          });
        }
      }
    };
    if (pending.length) onData(Buffer.alloc(0));
    socket.on('data', onData);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  gatewayUrl = `ws://127.0.0.1:${port}`;

  return {
    restApi: `http://127.0.0.1:${port}/api`,
    requests,
    count(method, pathSuffix) {
      return requests.filter((r) => r.method === method
        && (typeof pathSuffix === 'string' ? r.path.endsWith(pathSuffix) : pathSuffix.test(r.path))).length;
    },
    identifies: () => identifyCount,
    openGatewayConnections: () => gatewaySockets.size,
    get gatewayBot() { return fake.gatewayBot; },
    set gatewayBot(value) { fake.gatewayBot = value; },
    get commands() { return fake.commands; },
    set commands(value) { fake.commands = value; },
    get channel() { return fake.channel; },
    set channel(value) { fake.channel = value; },
    get guild() { return fake.guild; },
    set guild(value) { fake.guild = value; },
    get interactionCallback() { return fake.interactionCallback; },
    set interactionCallback(value) { fake.interactionCallback = value; },
    closeGateway(code, reason = '') {
      for (const [socket, state] of gatewaySockets) {
        state.closing = true;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        socket.write(frame(0x8, body));
        // The client answers with its own close frame; end the connection then, or here.
        setTimeout(() => socket.destroy(), 1_000).unref();
      }
    },
    async close() {
      for (const socket of gatewaySockets.keys()) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
