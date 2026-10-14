#!/usr/bin/env node
/**
 * The capture tool: a maintainer's instrument for holding the pack to a real stream. It runs for an afternoon on a host
 * Zoom can reach, behind TLS, with the app's credentials read from files; it is never part of a deployment. It answers
 * Zoom's webhook (the endpoint validation included), walks one person through Zoom's consent and keeps their tokens in
 * memory alone, starts and stops a stream through Zoom's API on an operator's call, records what Zoom's two connections
 * send for a set time, writes the raw record to a folder only the tool reads, and writes beside it the redacted fixture
 * and a summary with no name or identifier in it. Every operator route needs the operator's bearer. Its server is
 * `server.ts`; this file reads the settings and listens.
 *
 * Settings: `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET_FILE`, `ZOOM_WEBHOOK_SECRET_FILE`, `CAPTURE_OPERATOR_TOKEN_FILE`,
 * `CAPTURE_PUBLIC_URL` (its own address as Zoom and the browser see it), `CAPTURE_LISTEN` (`127.0.0.1:8791`),
 * `CAPTURE_OUT` (the folder), `CAPTURE_SILENCE_AUDIO` (`1` when the meeting carried a voice), and the protocol's open points: `ZOOM_RTMS_SIGNATURE_ENCODING`,
 * `ZOOM_RTMS_SIGNALING_SEQUENCE`, `ZOOM_RTMS_PCM_ORDER`. Each `_FILE` variable names a file that holds the secret; the
 * tool does not start when one of those files is empty.
 */
import { readFileSync } from 'node:fs';
import { createCaptureServer } from './server.js';

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

/**
 * A secret, from the file its variable names. An empty file stops the tool before it listens: an empty operator token
 * would match a call that carries no token, and an empty webhook secret would accept a signature anyone can make.
 */
function secretFile(name: string): string {
  const value = readFileSync(need(name), 'utf8').trim();
  if (value === '') throw new Error(`the file ${name} names is empty`);
  return value;
}

const server = createCaptureServer({
  clientId: need('ZOOM_CLIENT_ID'),
  clientSecret: secretFile('ZOOM_CLIENT_SECRET_FILE'),
  webhookSecret: secretFile('ZOOM_WEBHOOK_SECRET_FILE'),
  operatorToken: secretFile('CAPTURE_OPERATOR_TOKEN_FILE'),
  publicUrl: need('CAPTURE_PUBLIC_URL').replace(/\/$/, ''),
  out: need('CAPTURE_OUT'),
  protocol: {
    signatureEncoding: process.env.ZOOM_RTMS_SIGNATURE_ENCODING === 'base64' ? 'base64' : 'hex',
    signalingSequence: Number(process.env.ZOOM_RTMS_SIGNALING_SEQUENCE ?? '1'),
    pcmByteOrder: process.env.ZOOM_RTMS_PCM_ORDER === 'be' ? 'be' : 'le',
  },
  silenceAudio: process.env.CAPTURE_SILENCE_AUDIO === '1',
});

const [host, port] = (process.env.CAPTURE_LISTEN ?? '127.0.0.1:8791').split(':');
server.listen(Number(port ?? '8791'), host ?? '127.0.0.1', () => console.log(JSON.stringify({ event: 'zoom_capture', state: 'listening' })));
