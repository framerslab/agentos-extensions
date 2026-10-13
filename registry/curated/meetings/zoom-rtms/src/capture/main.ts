#!/usr/bin/env node
/**
 * The capture tool: a maintainer's instrument for holding the pack to a real stream. It runs for an afternoon on a host
 * Zoom can reach, behind TLS, with the app's credentials read from files; it is never part of a deployment. It answers
 * Zoom's webhook (the endpoint validation included), walks one person through Zoom's consent and keeps their tokens in
 * memory alone, starts and stops a stream through Zoom's API on an operator's call, records what Zoom's two connections
 * send for a set time, writes the raw record to a folder only the tool reads, and writes beside it the redacted fixture
 * and a summary with no name or identifier in it. Every operator route needs the operator's bearer.
 *
 * Settings: `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET_FILE`, `ZOOM_WEBHOOK_SECRET_FILE`, `CAPTURE_OPERATOR_TOKEN_FILE`,
 * `CAPTURE_PUBLIC_URL` (its own address as Zoom and the browser see it), `CAPTURE_LISTEN` (`127.0.0.1:8791`),
 * `CAPTURE_OUT` (the folder), `CAPTURE_SILENCE_AUDIO` (`1` when the meeting carried a voice), and the protocol's open points: `ZOOM_RTMS_SIGNATURE_ENCODING`,
 * `ZOOM_RTMS_SIGNALING_SEQUENCE`, `ZOOM_RTMS_PCM_ORDER`.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { ZoomApi, ZoomApiError } from '../api.js';
import { checkZoomEligibility } from '../eligibility.js';
import { ZoomOAuthError, exchangeZoomCode, refreshZoomToken, revokeZoomToken, zoomAuthorizeUrl, type ZoomOAuthConfig, type ZoomTokenSet } from '../oauth.js';
import { clientReady, decodePcm16, keepAliveResponse, mediaHandshake, pcm16Of, rtmsSignature, signalingHandshake, streamCloseRequest, subscribeActiveSpeaker } from '../rtms/messages.js';
import { closeStreamAtOnce } from '../rtms/session.js';
import { answerUrlValidation, firstServerUrl, readZoomWebhook, verifyZoomWebhook, type HeaderBag, type RtmsStarted } from '../webhook.js';
import { rms, zeroCrossingHz } from './measure.js';
import { redactCapture, type CaptureProtocol, type RawCapture } from './redact.js';

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}
const secretFile = (name: string): string => readFileSync(need(name), 'utf8').trim();

const clientId = need('ZOOM_CLIENT_ID');
const clientSecret = secretFile('ZOOM_CLIENT_SECRET_FILE');
const webhookSecret = secretFile('ZOOM_WEBHOOK_SECRET_FILE');
const operatorToken = secretFile('CAPTURE_OPERATOR_TOKEN_FILE');
const publicUrl = need('CAPTURE_PUBLIC_URL').replace(/\/$/, '');
const out = need('CAPTURE_OUT');
const protocol: CaptureProtocol = {
  signatureEncoding: process.env.ZOOM_RTMS_SIGNATURE_ENCODING === 'base64' ? 'base64' : 'hex',
  signalingSequence: Number(process.env.ZOOM_RTMS_SIGNALING_SEQUENCE ?? '1'),
  pcmByteOrder: process.env.ZOOM_RTMS_PCM_ORDER === 'be' ? 'be' : 'le',
};
const oauth: ZoomOAuthConfig = { clientId, clientSecret, redirectUri: `${publicUrl}/callback` };
/** Set when the test meeting carried a voice instead of the synthetic tone: the fixture then holds silence of the same lengths. */
const silenceAudio = process.env.CAPTURE_SILENCE_AUDIO === '1';
const api = new ZoomApi();
mkdirSync(out, { recursive: true, mode: 0o700 });

/** What the next started event is met with. */
let armed: { mode: 'record' | 'close'; seconds: number; closeByApp: boolean } | undefined;
let tokens: ZoomTokenSet | undefined;
let userId: string | undefined;
let state: string | undefined;
let captures = 0;
let lastSummary: Record<string, unknown> = { note: 'nothing recorded yet' };
/** The stream being recorded, and when its started event arrived. */
let current: RawCapture | undefined;
let currentBegan = 0;

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function operator(request: IncomingMessage): boolean {
  const given = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
  const wanted = Buffer.from(operatorToken);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
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

/** Records one stream: both connections, every message Zoom sends, for the armed time. */
function record(payload: RtmsStarted, startedBody: string, plan: { seconds: number; closeByApp: boolean }): void {
  const began = Date.now();
  const since = (): number => Date.now() - began;
  const raw: RawCapture = { protocol, webhooks: [{ ms: 0, body: startedBody }], signaling: [], media: [] };
  current = raw;
  const signature = rtmsSignature({ clientId, clientSecret, meetingUuid: payload.meeting_uuid, streamId: payload.rtms_stream_id, encoding: protocol.signatureEncoding });
  const signaling = new WebSocket(firstServerUrl(payload.server_urls));
  let media: WebSocket | undefined;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(limit);
    media?.terminate();
    signaling.terminate();
    captures += 1;
    writeFileSync(join(out, `raw-${captures}.json`), JSON.stringify(raw), { mode: 0o600 });
    writeFileSync(join(out, `fixture-${captures}.json`), `${JSON.stringify(redactCapture(raw, { silenceAudio }), null, 1)}\n`, { mode: 0o600 });
    lastSummary = { capture: captures, ...summarize(raw) };
    writeFileSync(join(out, `summary-${captures}.json`), `${JSON.stringify(lastSummary, null, 2)}\n`, { mode: 0o600 });
    current = undefined;
  };
  const limit = setTimeout(() => {
    if (plan.closeByApp && signaling.readyState === WebSocket.OPEN) signaling.send(JSON.stringify(streamCloseRequest(payload.rtms_stream_id)));
    setTimeout(finish, 5_000);
  }, plan.seconds * 1000);
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
      media = new WebSocket(url);
      const socket = media;
      socket.on('open', () => socket.send(JSON.stringify(mediaHandshake({ meetingUuid: payload.meeting_uuid, streamId: payload.rtms_stream_id, signature }))));
      socket.on('message', (mediaData: RawData, mediaBinary: boolean) => {
        if (mediaBinary) {
          raw.media.push({ ms: since(), binary: true, base64: Buffer.from(mediaData as Buffer).toString('base64') });
          return;
        }
        const mediaText = mediaData.toString();
        raw.media.push({ ms: since(), binary: false, text: mediaText });
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
  signaling.on('close', () => setTimeout(finish, 1_000));
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', publicUrl);
  const path = url.pathname.replace(/^\/zoom-capture/, '') || '/';
  if (request.method === 'GET' && path === '/health') return send(response, 200, { ok: true });

  if (request.method === 'POST' && path === '/webhook') {
    const body = await bodyOf(request);
    if (!verifyZoomWebhook({ secretToken: webhookSecret, headers: request.headers as HeaderBag, rawBody: body })) return send(response, 401, { error: 'bad signature' });
    const webhook = readZoomWebhook(body);
    if (webhook.kind === 'url_validation') return send(response, 200, answerUrlValidation(webhookSecret, webhook.plainToken));
    if (webhook.kind === 'rtms_started') {
      const plan = armed;
      armed = undefined;
      if (plan?.mode === 'record') {
        currentBegan = Date.now();
        record(webhook.payload, body, plan);
      } else if (plan?.mode === 'close') {
        const closed = await closeStreamAtOnce({ clientId, clientSecret, meetingUuid: webhook.payload.meeting_uuid, streamId: webhook.payload.rtms_stream_id, serverUrls: webhook.payload.server_urls, signatureEncoding: protocol.signatureEncoding, signalingSequence: protocol.signalingSequence });
        lastSummary = { closeAtOnce: closed };
      } else {
        lastSummary = { unarmedStart: true };
      }
    } else if (webhook.kind === 'rtms_stopped' || webhook.kind === 'rtms_interrupted') {
      if (current !== undefined) current.webhooks.push({ ms: Date.now() - currentBegan, body });
      else lastSummary = { ...lastSummary, lateWebhook: webhook.kind, stop_reason: webhook.kind === 'rtms_stopped' ? webhook.payload.stop_reason : null };
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
    tokens = await exchangeZoomCode(oauth, url.searchParams.get('code') ?? '', Date.now());
    userId = (await api.me(tokens.accessToken)).id;
    return send(response, 200, { connected: true, scope: tokens.scope });
  }

  if (!operator(request)) return send(response, 401, { error: 'unauthorized' });
  const input = request.method === 'POST' ? ((JSON.parse((await bodyOf(request)) || '{}') as Record<string, unknown>) ?? {}) : {};
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
      tokens = await refreshZoomToken(oauth, held.refreshToken, Date.now());
    });
    const second = await outcome(async () => {
      await refreshZoomToken(oauth, held.refreshToken, Date.now());
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

const [host, port] = (process.env.CAPTURE_LISTEN ?? '127.0.0.1:8791').split(':');
createServer((request, response) => {
  void route(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
}).listen(Number(port ?? '8791'), host ?? '127.0.0.1', () => console.log(JSON.stringify({ event: 'zoom_capture', state: 'listening' })));
