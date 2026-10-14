/**
 * The capture tool's server. It answers Zoom's webhook (the endpoint validation included), walks one person through
 * Zoom's consent and keeps their tokens in memory alone, starts and stops a stream through Zoom's API on an operator's
 * call, records what Zoom's two connections send for a set time, writes the raw record to a folder only the tool reads,
 * and writes beside it the redacted fixture and a summary with no name or identifier in it. Every operator route needs
 * the operator's bearer. A webhook is acted on only when Zoom signed it within the window the provider holds a new
 * delivery to (`verifyFreshZoomWebhook`). A body past its limit, `ZOOM_WEBHOOK_MAX_BYTES` for the webhook and
 * {@link CAPTURE_CONTROL_MAX_BYTES} for an operator call, is refused with 413 and a line, and is not kept. The tool's
 * process, `main.ts`, reads its settings and listens. A recording is written once its stream has ended and Zoom's
 * stopped webhook has come, or {@link STOPPED_WEBHOOK_WAIT_MS} after Zoom closed the stream's signaling connection
 * without it. It keeps the stream's media frames while their bytes stay within {@link CAPTURE_MEDIA_MAX_BYTES} and
 * counts the frames it drops after them in its summary, so a long meeting cannot grow the record and the fixture without
 * bound.
 *
 * @module
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { ZoomApi, ZoomApiError } from '../api.js';
import { checkZoomEligibility } from '../eligibility.js';
import { ZoomOAuthError, exchangeZoomCode, refreshZoomToken, revokeZoomToken, zoomAuthorizeUrl, type ZoomOAuthConfig, type ZoomTokenSet } from '../oauth.js';
import { clientReady, decodePcm16, keepAliveResponse, mediaHandshake, pcm16Of, rtmsSignature, signalingHandshake, streamCloseRequest, subscribeActiveSpeaker } from '../rtms/messages.js';
import { closeStreamAtOnce } from '../rtms/session.js';
import { ZOOM_WEBHOOK_MAX_BYTES, answerUrlValidation, firstServerUrl, readZoomWebhook, verifyFreshZoomWebhook, verifyZoomWebhook, type HeaderBag, type RtmsStarted, type ZoomWebhook } from '../webhook.js';
import { rms, zeroCrossingHz } from './measure.js';
import { redactCapture, type CaptureProtocol, type RawCapture } from './redact.js';

/** The most bytes an operator call's body may hold: its JSON names a meeting's number or a recording's plan. */
export const CAPTURE_CONTROL_MAX_BYTES = 16_384;

/**
 * How long a recording waits, after Zoom closes the stream's signaling connection, for Zoom's `meeting.rtms_stopped`
 * before it writes its record: five seconds, the pack's own figure. Zoom's pages say a stopped notification comes when
 * a stream ends, and name no order between it and the connection's close
 * (https://developers.zoom.us/docs/rtms/meetings/work-with-streams.md, "Step 7: Stream ends";
 * https://developers.zoom.us/docs/rtms/meetings/failover-reconnection.md, "Scenario 4: Stream terminated"). A stop
 * that has come is written a second after the close, for the media frames still on their way. A stop that comes after
 * the record is written is kept in the summary as `lateWebhook`.
 */
export const STOPPED_WEBHOOK_WAIT_MS = 5_000;

/**
 * The most bytes of a stream's media frames a recording keeps, counted as they arrive: 8 MiB, the pack's own figure,
 * some three minutes of the mixed audio in Zoom's JSON messages (16 kHz mono 16-bit samples in base64, a message every
 * 20 milliseconds) and longer as binary frames. Every frame after the first that does not fit is dropped.
 */
export const CAPTURE_MEDIA_MAX_BYTES = 8 * 1_048_576;

/**
 * What a line of the tool says happened: it listens, a request's body was past its limit and was refused with 413, or a
 * recording's media reached its cap and the frames after it are dropped.
 */
export type CaptureLogState = 'listening' | 'body_too_large' | 'media_capped';

/** One line's fields. A line names a route of the tool's own and a figure, never a word, a name or an address of a meeting. */
export type CaptureLogFields = {
  event: 'zoom_capture';
  state: CaptureLogState;
  /** The tool's route a refused body came to. */
  route?: string;
  /** The limit a body or a recording's media was past, in bytes. */
  limit?: number;
};

/** Where the tool's lines go: AgentOS's `ILogger` shape, a line's state as the message and its fields beside it. */
export interface CaptureLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** What the tool runs with: the Zoom app's id and secrets, the operator's token, the tool's address and folder, and how it records. */
export interface CaptureSettings {
  /** The Zoom app's client id. */
  clientId: string;
  /** The app's client secret: it signs the stream's handshakes and the OAuth calls. */
  clientSecret: string;
  /** The app's webhook secret token. */
  webhookSecret: string;
  /** The bearer every operator route needs. */
  operatorToken: string;
  /** The tool's own address as Zoom and the browser see it, with no slash at its end. */
  publicUrl: string;
  /** The folder the records are written to, made with mode 0700 when it is missing. */
  out: string;
  /** The protocol's open points the recording runs with. */
  protocol: CaptureProtocol;
  /** Set when the test meeting carried a voice instead of the synthetic tone: the fixture then holds silence of the same lengths. */
  silenceAudio: boolean;
}

/** Where the tool's lines go, and what a test may replace: how a WebSocket to one of Zoom's addresses is opened, Zoom's API client, and the clock. */
export interface CaptureServerOptions {
  /** Where the tool's lines ({@link CaptureLogFields}) go. Without it the server writes none. */
  logger?: CaptureLogger;
  /** Opens a WebSocket to an address Zoom named. Default: `new WebSocket(url)`. */
  connect?: (url: string) => WebSocket;
  /** Zoom's API. Default: a `ZoomApi` on Zoom's own address. */
  api?: ZoomApi;
  /** The most bytes of a stream's media frames a recording keeps. Default {@link CAPTURE_MEDIA_MAX_BYTES}. */
  mediaMaxBytes?: number;
  /** Milliseconds since the epoch. Default: `Date.now`. */
  clock?: () => number;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * A request's body as text, or `undefined` when it holds more than `limit` bytes. A body whose declared length is past
 * the limit is not read; one that passes the limit as it streams is read on and dropped, never kept, so the answer still
 * reaches the sender.
 */
function boundedBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      if (size > limit) return;
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      resolve(undefined);
    });
    request.on('end', () => resolve(size > limit ? undefined : Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** A call's outcome as the record takes it: the status and Zoom's code, never its words. */
async function outcome(call: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    const value = await call();
    return { ok: true, ...(value === undefined ? {} : { value }) };
  } catch (error) {
    if (error instanceof ZoomApiError) return { ok: false, status: error.status, code: error.code ?? null };
    if (error instanceof ZoomOAuthError) return { ok: false, status: error.status, code: error.code ?? null };
    return { ok: false, error: error instanceof Error ? error.name : 'error' };
  }
}

/** What a record shows of the protocol's open points, with no name, identifier or address in it. */
function summarize(raw: RawCapture): Record<string, unknown> {
  const types = (entries: RawCapture['signaling']): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of entries) {
      let key = entry.binary ? 'binary' : 'unreadable';
      if (!entry.binary) {
        try {
          key = String((JSON.parse(entry.text ?? '') as { msg_type?: unknown }).msg_type);
        } catch {
          // counted as unreadable
        }
      }
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };
  const json = (text: string | undefined): Record<string, any> => {
    try {
      return JSON.parse(text ?? '') as Record<string, any>;
    } catch {
      return {};
    }
  };
  const gaps = (entries: RawCapture['signaling'], type: number): number[] => {
    const stamps = entries.filter((entry) => !entry.binary && json(entry.text).msg_type === type).map((entry) => entry.ms);
    return stamps.slice(1).map((ms, index) => ms - stamps[index]);
  };
  const packets = (order: 'le' | 'be'): Int16Array[] =>
    raw.media.flatMap((entry) => {
      if (entry.binary) return entry.base64 === undefined ? [] : [pcm16Of(Buffer.from(entry.base64, 'base64'), order)];
      const data = json(entry.text).content?.data;
      return json(entry.text).msg_type === 14 && typeof data === 'string' ? [decodePcm16(data, order)] : [];
    });
  const voiced = (order: 'le' | 'be'): number => {
    const loud = packets(order).filter((packet) => rms(packet) > 0.01);
    return loud.length === 0 ? -1 : loud.filter((packet) => zeroCrossingHz(packet, 16_000) < 3_000).length / loud.length;
  };
  const sizes: Record<string, number> = {};
  for (const packet of packets('le')) sizes[String(packet.length)] = (sizes[String(packet.length)] ?? 0) + 1;
  const audioTimes = raw.media.flatMap((entry) => (entry.binary ? [] : typeof json(entry.text).content?.timestamp === 'number' && json(entry.text).msg_type === 14 ? [json(entry.text).content.timestamp as number] : []));
  const ends = raw.signaling.flatMap((entry) => {
    const message = json(entry.text);
    return message.msg_type === 8 || message.msg_type === 9 ? [{ msg_type: message.msg_type, state: message.state ?? null, reason: message.reason ?? message.stop_reason ?? null }] : [];
  });
  return {
    protocol: raw.protocol,
    signalingStatus: json(raw.signaling[0]?.text).status_code ?? null,
    mediaStatus: json(raw.media.find((entry) => !entry.binary)?.text).status_code ?? null,
    payloadEncrypted: json(raw.media.find((entry) => !entry.binary)?.text).payload_encrypted ?? null,
    mediaParams: json(raw.media.find((entry) => !entry.binary)?.text).media_params?.audio ?? null,
    signalingTypes: types(raw.signaling),
    mediaTypes: types(raw.media),
    audioPackets: packets('le').length,
    audioAsBinaryFrames: raw.media.some((entry) => entry.binary),
    samplesPerPacket: sizes,
    audioTimestampStepMs: audioTimes.slice(1, 6).map((time, index) => time - audioTimes[index]),
    audioSpanMs: raw.media.length > 1 ? raw.media.at(-1)!.ms - raw.media[1].ms : 0,
    voicedShareLittleEndian: voiced('le'),
    voicedShareBigEndian: voiced('be'),
    keepAliveGapsSignalingMs: gaps(raw.signaling, 12),
    keepAliveGapsMediaMs: gaps(raw.media, 12),
    ends,
    webhooks: raw.webhooks.map((entry) => ({ ms: entry.ms, event: json(entry.body).event ?? null, stop_reason: json(entry.body).payload?.stop_reason ?? null, has_server_urls: typeof json(entry.body).payload?.server_urls === 'string' })),
  };
}

/**
 * The capture tool's server, not yet listening. It makes the settings' folder when it is missing, and holds what one
 * afternoon's capture needs in memory alone: the armed plan, one person's tokens, the stream being recorded and the
 * last record's summary.
 */
export function createCaptureServer(settings: CaptureSettings, options: CaptureServerOptions = {}): Server {
  const { clientId, clientSecret, webhookSecret, operatorToken, publicUrl, out, protocol, silenceAudio } = settings;
  const connect = options.connect ?? ((url: string): WebSocket => new WebSocket(url));
  const api = options.api ?? new ZoomApi();
  const now = options.clock ?? Date.now;
  const mediaMaxBytes = options.mediaMaxBytes ?? CAPTURE_MEDIA_MAX_BYTES;
  const oauth: ZoomOAuthConfig = { clientId, clientSecret, redirectUri: `${publicUrl}/callback` };
  mkdirSync(out, { recursive: true, mode: 0o700 });

  /** Writes one of the tool's lines, its state as the message and its fields beside it. */
  const line = (level: 'info' | 'warn', fields: CaptureLogFields): void => options.logger?.[level](fields.state, fields);

  /** Refuses a body past its limit: one line naming the route and the limit, then 413. */
  const tooLarge = (response: ServerResponse, route: string, limit: number): void => {
    line('warn', { event: 'zoom_capture', state: 'body_too_large', route, limit });
    send(response, 413, { error: 'too large' });
  };

  /** What the next started event is met with. */
  let armed: { mode: 'record' | 'close'; seconds: number; closeByApp: boolean } | undefined;
  let tokens: ZoomTokenSet | undefined;
  let userId: string | undefined;
  let state: string | undefined;
  let captures = 0;
  let lastSummary: Record<string, unknown> = { note: 'nothing recorded yet' };
  /** The stream being recorded, when its started event arrived, and what its stopped webhook sets off. */
  let current: RawCapture | undefined;
  let currentBegan = 0;
  let currentStopped: ((streamId: string) => void) | undefined;

  function operator(request: IncomingMessage): boolean {
    const given = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
    const wanted = Buffer.from(operatorToken);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  /**
   * Records one stream: both connections, every message Zoom sends, for the armed time. The record is written a second
   * after Zoom closes the signaling connection when Zoom's stopped webhook for the stream has come, as soon as it comes
   * after that, or {@link STOPPED_WEBHOOK_WAIT_MS} after the close when it has not.
   */
  function record(payload: RtmsStarted, startedBody: string, plan: { seconds: number; closeByApp: boolean }): void {
    const began = now();
    const since = (): number => now() - began;
    const raw: RawCapture = { protocol, webhooks: [{ ms: 0, body: startedBody }], signaling: [], media: [] };
    current = raw;
    const signature = rtmsSignature({ clientId, clientSecret, meetingUuid: payload.meeting_uuid, streamId: payload.rtms_stream_id, encoding: protocol.signatureEncoding });
    const signaling = connect(firstServerUrl(payload.server_urls));
    let media: WebSocket | undefined;
    let finished = false;
    /** Zoom's stopped webhook for this stream has come; a second has passed since the signaling connection closed. */
    let stopSeen = false;
    let settled = false;
    /** The latest bound on when the record is written, and the second after the close. */
    let endTimer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    /** The bytes of the media frames kept, and the frames and bytes dropped since the first that did not fit. */
    let mediaKept = 0;
    let mediaCapped = false;
    const mediaDropped = { frames: 0, bytes: 0 };
    /**
     * Whether a media frame of `size` bytes is kept: while the frames' bytes stay within the cap, and never after the
     * first frame that does not fit. The first dropped frame writes one line; every dropped frame is counted.
     */
    const keepMedia = (size: number): boolean => {
      if (!mediaCapped && mediaKept + size <= mediaMaxBytes) {
        mediaKept += size;
        return true;
      }
      if (!mediaCapped) {
        mediaCapped = true;
        line('warn', { event: 'zoom_capture', state: 'media_capped', limit: mediaMaxBytes });
      }
      mediaDropped.frames += 1;
      mediaDropped.bytes += size;
      return false;
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(limit);
      clearTimeout(endTimer);
      clearTimeout(settleTimer);
      media?.terminate();
      signaling.terminate();
      captures += 1;
      writeFileSync(join(out, `raw-${captures}.json`), JSON.stringify(raw), { mode: 0o600 });
      writeFileSync(join(out, `fixture-${captures}.json`), `${JSON.stringify(redactCapture(raw, { silenceAudio }), null, 1)}\n`, { mode: 0o600 });
      lastSummary = { capture: captures, ...summarize(raw), mediaMaxBytes, mediaDropped: { ...mediaDropped } };
      writeFileSync(join(out, `summary-${captures}.json`), `${JSON.stringify(lastSummary, null, 2)}\n`, { mode: 0o600 });
      // left as they are when a recording that started while this one ran holds them
      if (current === raw) {
        current = undefined;
        currentStopped = undefined;
      }
    };
    /** Writes the record `ms` from now, in place of any earlier bound. */
    const endIn = (ms: number): void => {
      clearTimeout(endTimer);
      endTimer = setTimeout(finish, ms);
    };
    const limit = setTimeout(() => {
      if (plan.closeByApp && signaling.readyState === WebSocket.OPEN) signaling.send(JSON.stringify(streamCloseRequest(payload.rtms_stream_id)));
      // a stream whose connection Zoom does not close within five seconds is written all the same
      endIn(5_000);
    }, plan.seconds * 1000);
    currentStopped = (streamId: string): void => {
      if (streamId !== payload.rtms_stream_id) return;
      stopSeen = true;
      if (settled) finish();
    };
    signaling.on('open', () => signaling.send(JSON.stringify(signalingHandshake({ meetingUuid: payload.meeting_uuid, streamId: payload.rtms_stream_id, signature, sequence: protocol.signalingSequence }))));
    signaling.on('message', (data: RawData, isBinary: boolean) => {
      const text = data.toString();
      raw.signaling.push(isBinary ? { ms: since(), binary: true, base64: Buffer.from(data as Buffer).toString('base64') } : { ms: since(), binary: false, text });
      let message: Record<string, any> = {};
      try {
        message = JSON.parse(text) as Record<string, any>;
      } catch {
        return;
      }
      if (message.msg_type === 2 && message.status_code === 0) {
        const url = message.media_server?.server_urls?.audio ?? message.media_server?.server_urls?.all;
        if (typeof url !== 'string') return;
        media = connect(url);
        const socket = media;
        socket.on('open', () => socket.send(JSON.stringify(mediaHandshake({ meetingUuid: payload.meeting_uuid, streamId: payload.rtms_stream_id, signature }))));
        socket.on('message', (mediaData: RawData, mediaBinary: boolean) => {
          if (mediaBinary) {
            const frame = mediaData as Buffer;
            if (keepMedia(frame.length)) raw.media.push({ ms: since(), binary: true, base64: Buffer.from(frame).toString('base64') });
            return;
          }
          const mediaText = mediaData.toString();
          // a text frame past the cap is not kept, and is still read: the keep-alives are answered to the stream's end
          if (keepMedia(Buffer.byteLength(mediaText))) raw.media.push({ ms: since(), binary: false, text: mediaText });
          try {
            const mediaMessage = JSON.parse(mediaText) as Record<string, any>;
            if (mediaMessage.msg_type === 4 && mediaMessage.status_code === 0) {
              signaling.send(JSON.stringify(clientReady(payload.rtms_stream_id)));
              signaling.send(JSON.stringify(subscribeActiveSpeaker()));
            }
            if (mediaMessage.msg_type === 12) socket.send(JSON.stringify(keepAliveResponse(mediaMessage.timestamp)));
          } catch {
            // recorded as it came
          }
        });
        socket.on('error', () => undefined);
      }
      if (message.msg_type === 12) signaling.send(JSON.stringify(keepAliveResponse(message.timestamp)));
      if (message.msg_type === 2 && message.status_code !== 0) setTimeout(finish, 500);
    });
    signaling.on('error', () => undefined);
    // Zoom names no order between this close and its stopped webhook: the wait for the stop starts here, in place of
    // the armed time's end, and the record keeps whatever comes in the second after the close
    signaling.on('close', () => {
      clearTimeout(limit);
      endIn(STOPPED_WEBHOOK_WAIT_MS);
      settleTimer = setTimeout(() => {
        settled = true;
        if (stopSeen) finish();
      }, 1_000);
    });
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', publicUrl);
    const path = url.pathname.replace(/^\/zoom-capture/, '') || '/';
    if (request.method === 'GET' && path === '/health') return send(response, 200, { ok: true });

    if (request.method === 'POST' && path === '/webhook') {
      const body = await boundedBody(request, ZOOM_WEBHOOK_MAX_BYTES);
      if (body === undefined) return tooLarge(response, path, ZOOM_WEBHOOK_MAX_BYTES);
      const headers = request.headers as HeaderBag;
      if (!verifyZoomWebhook({ secretToken: webhookSecret, headers, rawBody: body })) return send(response, 401, { error: 'bad signature' });
      let webhook: ZoomWebhook;
      try {
        webhook = readZoomWebhook(body);
      } catch {
        return send(response, 400, { error: 'unreadable' });
      }
      // the window the provider and the media worker hold a new delivery to: signed no more than 90 minutes ago and
      // no more than a minute ahead, so a signed request replayed later starts nothing
      if (!verifyFreshZoomWebhook({ secretToken: webhookSecret, headers, rawBody: body, now: now() })) return send(response, 401, { error: 'expired delivery' });
      if (webhook.kind === 'url_validation') return send(response, 200, answerUrlValidation(webhookSecret, webhook.plainToken));
      if (webhook.kind === 'rtms_started') {
        const plan = armed;
        armed = undefined;
        if (plan?.mode === 'record') {
          currentBegan = now();
          record(webhook.payload, body, plan);
        } else if (plan?.mode === 'close') {
          const closed = await closeStreamAtOnce({ clientId, clientSecret, meetingUuid: webhook.payload.meeting_uuid, streamId: webhook.payload.rtms_stream_id, serverUrls: webhook.payload.server_urls, signatureEncoding: protocol.signatureEncoding, signalingSequence: protocol.signalingSequence, connect: options.connect });
          lastSummary = { closeAtOnce: closed };
        } else {
          lastSummary = { unarmedStart: true };
        }
      } else if (webhook.kind === 'rtms_stopped' || webhook.kind === 'rtms_interrupted') {
        if (current !== undefined) {
          current.webhooks.push({ ms: now() - currentBegan, body });
          // the stop of the stream being recorded ends its wait: the record is written now, or a second after the close
          if (webhook.kind === 'rtms_stopped') currentStopped?.(webhook.payload.rtms_stream_id);
        } else lastSummary = { ...lastSummary, lateWebhook: webhook.kind, stop_reason: webhook.kind === 'rtms_stopped' ? webhook.payload.stop_reason : null };
      }
      return send(response, 200, { ok: true });
    }

    if (request.method === 'GET' && path === '/connect') {
      state = randomBytes(24).toString('base64url');
      response.writeHead(302, { location: zoomAuthorizeUrl(oauth, state) });
      response.end();
      return;
    }
    if (request.method === 'GET' && path === '/callback') {
      if (state === undefined || url.searchParams.get('state') !== state) return send(response, 400, { error: 'state' });
      state = undefined;
      tokens = await exchangeZoomCode(oauth, url.searchParams.get('code') ?? '', now());
      userId = (await api.me(tokens.accessToken)).id;
      return send(response, 200, { connected: true, scope: tokens.scope });
    }

    if (!operator(request)) return send(response, 401, { error: 'unauthorized' });
    let input: Record<string, unknown> = {};
    if (request.method === 'POST') {
      const text = await boundedBody(request, CAPTURE_CONTROL_MAX_BYTES);
      if (text === undefined) return tooLarge(response, path, CAPTURE_CONTROL_MAX_BYTES);
      input = (JSON.parse(text || '{}') as Record<string, unknown> | null) ?? {};
    }
    const meeting = String(input.meetingNumber ?? '');
    if (path === '/result') return send(response, 200, lastSummary);
    if (path === '/arm') {
      armed = { mode: input.mode === 'close' ? 'close' : 'record', seconds: Number(input.seconds ?? 40), closeByApp: input.closeByApp !== false };
      return send(response, 200, { armed });
    }
    if (tokens === undefined || userId === undefined) return send(response, 409, { error: 'connect first' });
    const held = tokens;
    const user = userId;
    if (path === '/start') return send(response, 200, await outcome(() => api.setRtmsStatus(held.accessToken, meeting, 'start', { clientId, participantUserId: user })));
    if (path === '/stop') return send(response, 200, await outcome(() => api.setRtmsStatus(held.accessToken, meeting, 'stop', { clientId, participantUserId: user })));
    if (path === '/meeting') return send(response, 200, await outcome(async () => ({ status: (await api.meeting(held.accessToken, meeting)).status })));
    if (path === '/eligibility') return send(response, 200, await outcome(() => checkZoomEligibility(api, held.accessToken, meeting)));
    if (path === '/refresh-twice') {
      const first = await outcome(async () => {
        tokens = await refreshZoomToken(oauth, held.refreshToken, now());
      });
      const second = await outcome(async () => {
        await refreshZoomToken(oauth, held.refreshToken, now());
      });
      return send(response, 200, { first, secondWithTheSameToken: second });
    }
    if (path === '/disconnect') {
      const revoked = await outcome(() => revokeZoomToken(oauth, held.accessToken));
      tokens = undefined;
      userId = undefined;
      return send(response, 200, { revoked });
    }
    send(response, 404, { error: 'not found' });
  }

  return createServer((request, response) => {
    void route(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}
