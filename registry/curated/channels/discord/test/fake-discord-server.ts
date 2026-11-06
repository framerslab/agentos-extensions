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
 * whether it carried an Authorization header, never the header's value, and the
 * body of each `POST /channels/:id/messages`, which it answers with the message
 * it created, and of each `POST /interactions/:id/:token/callback`.
 *
 * It holds the application's slash commands as Discord does, in the global
 * scope and per guild: `GET`, `POST` and `PATCH` under
 * `/applications/:id/commands` and `/applications/:id/guilds/:id/commands` list,
 * create and edit them, and the body of each create and edit is recorded.
 * `GET /guilds/:id` answers a guild that `addGuild` gave it, else 404 Unknown
 * Guild.
 *
 * The gateway records the `intents` of each IDENTIFY, and `dispatch(event, data)`
 * sends a DISPATCH to every open connection, as Discord sends `GUILD_CREATE` or
 * `MESSAGE_CREATE`. It sends what the test gives it whatever the intents say:
 * Discord itself sends an event only under its intent, so a test reads
 * `intents` for that.
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
  /**
   * The body of a `POST /channels/:id/messages`, a
   * `POST /interactions/:id/:token/callback`, or a slash command's create
   * (`POST`) or edit (`PATCH`) in either scope; absent on other routes.
   */
  body?: unknown;
}

export interface FakeDiscord {
  /** The value for discord.js's `rest.api` option. */
  restApi: string;
  requests: FakeDiscordRequest[];
  /** How many requests matched `method` and a path ending in `pathSuffix`. */
  count(method: string, pathSuffix: string | RegExp): number;
  /** How many IDENTIFY payloads the gateway received. */
  identifies(): number;
  /** The `intents` of each IDENTIFY the gateway received, in order. */
  intents: number[];
  /**
   * Sends a gateway DISPATCH (`op` 0) named `event` with `data` to every open
   * connection that has identified, with the next sequence number of each.
   */
  dispatch(event: string, data: unknown): void;
  /** How many gateway connections are open. */
  openGatewayConnections(): number;
  /** The answer of `GET /gateway/bot`. Default `ok`. */
  gatewayBot: RouteAnswer;
  /** The answer of `GET /applications/:id/commands`. Default `ok` (the global commands it holds, none at first). */
  commands: RouteAnswer;
  /** The answer of `GET /channels/:id`. Default `ok` (a DM channel). */
  channel: RouteAnswer;
  /**
   * The answer of `GET /guilds/:id`. Default `ok`, which answers the guild
   * `addGuild` gave, else 404 Unknown Guild.
   */
  guild: RouteAnswer;
  /** Makes `GET /guilds/:id` answer `guild` (a guild object as Discord sends it) for its `id`. */
  addGuild(guild: { id: string }): void;
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

/** The bot's user object, as READY and the bot's own messages carry it. */
export const BOT_USER = { id: BOT_USER_ID, username: 'test-bot', discriminator: '0', global_name: null, avatar: null, bot: true, flags: 0 };

/** Discord's epoch, the first second of 2015, in milliseconds. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
let snowflakeIncrement = 0n;

/** A new snowflake id for the current time, as Discord gives a message it creates. */
export function snowflake(): string {
  snowflakeIncrement = (snowflakeIncrement + 1n) & 0xfffn;
  return String(((BigInt(Date.now()) - DISCORD_EPOCH_MS) << 22n) | snowflakeIncrement);
}

/** A request body as the test reads it: JSON parsed, anything else as text. */
function readBody(raw: Buffer, contentType: string | undefined): unknown {
  const text = raw.toString('utf8');
  if (String(contentType ?? '').includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

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

/** One gateway connection: whether it is closing, its sender, its last sequence number. */
interface GatewayConnection {
  closing: boolean;
  identified: boolean;
  sequence: number;
  send(payload: unknown): void;
}

export async function startFakeDiscord(): Promise<FakeDiscord> {
  const requests: FakeDiscordRequest[] = [];
  const gatewaySockets = new Map<Socket, GatewayConnection>();
  const intents: number[] = [];
  let identifyCount = 0;
  let gatewayUrl = '';
  /** The application's slash commands, by scope: `global`, or a guild's id. */
  const slashCommands = new Map<string, any[]>();
  const commandsIn = (scope: string): any[] => {
    if (!slashCommands.has(scope)) slashCommands.set(scope, []);
    return slashCommands.get(scope)!;
  };
  /** The guilds `GET /guilds/:id` answers, by id. */
  const guilds = new Map<string, unknown>();

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
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const method = req.method ?? 'GET';
      const request: FakeDiscordRequest = { method, path, authorized: typeof req.headers.authorization === 'string' };
      const channelMessages = method === 'POST' ? /\/channels\/(\d+)\/messages$/.exec(path) : null;
      const interactionCallback = method === 'POST' && /\/interactions\/\d+\/[^/]+\/callback$/.test(path);
      const commandList = /\/applications\/(\d+)(?:\/guilds\/(\d+))?\/commands$/.exec(path);
      const oneCommand = /\/applications\/(\d+)(?:\/guilds\/(\d+))?\/commands\/(\d+)$/.exec(path);
      const commandWrite = (method === 'POST' && commandList) || (method === 'PATCH' && oneCommand);
      if (channelMessages || interactionCallback || commandWrite) {
        request.body = readBody(Buffer.concat(chunks), req.headers['content-type']);
      }
      requests.push(request);

      if (channelMessages) {
        const body = request.body as { content?: unknown } | undefined;
        return json(res, 200, {
          id: snowflake(),
          channel_id: channelMessages[1],
          type: 0,
          content: typeof body?.content === 'string' ? body.content : '',
          author: BOT_USER,
          timestamp: new Date().toISOString(),
          edited_timestamp: null,
          tts: false,
          mention_everyone: false,
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: [],
          pinned: false,
          flags: 0,
          components: [],
        });
      }

      if (method === 'GET' && /\/gateway\/bot$/.test(path)) {
        return route(res, fake.gatewayBot, () => ({
          url: gatewayUrl,
          shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 86_400_000, max_concurrency: 1 },
        }));
      }
      if (method === 'GET' && commandList && !commandList[2]) {
        return route(res, fake.commands, () => commandsIn('global'));
      }
      if (method === 'GET' && commandList) {
        return json(res, 200, commandsIn(commandList[2]));
      }
      if (method === 'POST' && commandList) {
        // A create, as Discord answers it: the command with its id, its
        // application and, in a guild's scope, its guild.
        const [, applicationId, guildId] = commandList;
        const body = (request.body ?? {}) as Record<string, unknown>;
        const created = {
          id: snowflake(),
          application_id: applicationId,
          ...(guildId ? { guild_id: guildId } : {}),
          version: snowflake(),
          default_member_permissions: null,
          ...body,
          type: body.type ?? 1,
        };
        commandsIn(guildId ?? 'global').push(created);
        return json(res, 201, created);
      }
      if (method === 'PATCH' && oneCommand) {
        const [, , guildId, commandId] = oneCommand;
        const scope = commandsIn(guildId ?? 'global');
        const index = scope.findIndex((command) => command.id === commandId);
        if (index < 0) return json(res, 404, { message: 'Unknown application command', code: 10063 });
        scope[index] = { ...scope[index], ...(request.body as Record<string, unknown>), id: commandId, version: snowflake() };
        return json(res, 200, scope[index]);
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
      const guild = /\/guilds\/(\d+)$/.exec(path);
      if (method === 'GET' && guild) {
        if (fake.guild === 'ok' && !guilds.has(guild[1])) return json(res, 404, { message: 'Unknown Guild', code: 10004 });
        return route(res, fake.guild, () => guilds.get(guild[1]));
      }
      if (interactionCallback) {
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
    const send = (payload: unknown) => {
      if (!socket.destroyed) socket.write(frame(0x1, Buffer.from(JSON.stringify(payload))));
    };
    const state: GatewayConnection = { closing: false, identified: false, sequence: 0, send };
    gatewaySockets.set(socket, state);
    socket.on('close', () => gatewaySockets.delete(socket));
    socket.on('error', () => { /* the client went away */ });

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
          intents.push(Number(message.d?.intents));
          state.identified = true;
          state.sequence = 1;
          send({
            op: 0,
            s: state.sequence,
            t: 'READY',
            d: {
              v: 10,
              user: BOT_USER,
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
    intents,
    dispatch(event, data) {
      for (const connection of gatewaySockets.values()) {
        if (!connection.identified || connection.closing) continue;
        connection.sequence++;
        connection.send({ op: 0, s: connection.sequence, t: event, d: data });
      }
    },
    openGatewayConnections: () => gatewaySockets.size,
    get gatewayBot() { return fake.gatewayBot; },
    set gatewayBot(value) { fake.gatewayBot = value; },
    get commands() { return fake.commands; },
    set commands(value) { fake.commands = value; },
    get channel() { return fake.channel; },
    set channel(value) { fake.channel = value; },
    get guild() { return fake.guild; },
    set guild(value) { fake.guild = value; },
    addGuild(value) {
      guilds.set(value.id, value);
    },
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
