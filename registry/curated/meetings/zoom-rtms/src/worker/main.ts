#!/usr/bin/env node
/**
 * The media worker as a process. Its settings are environment variables; each secret is read from the file its
 * variable names, never from the environment itself:
 *
 * - `ZOOM_MEDIA_WORKER_ID`: its id, as the provider's options name it.
 * - `ZOOM_MEDIA_LISTEN`: `host:port`. Default `0.0.0.0:8790`.
 * - `ZOOM_MEDIA_SLOTS`: runs held at once. Default 4.
 * - `ZOOM_MEDIA_CLIENT_TOKEN_FILE`: the credential the provider presents.
 * - `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET_FILE`, `ZOOM_WEBHOOK_SECRET_FILE`: the Zoom app's.
 * - `ZOOM_MEDIA_REPORT_ORIGIN`: the origin every run's report address must have.
 * - `ZOOM_MEDIA_REPORT_VIA`: the host's address inside this network, when reports should not leave it.
 * - `ZOOM_MEDIA_LIVEKIT_URL`: the LiveKit server's address inside this network, when it differs from the one runs name.
 * - `ZOOM_MEDIA_STATE_DIR`: the folder of its state files. Default `/var/lib/zoom-media`.
 * - `ZOOM_RTMS_SIGNATURE_ENCODING` (`hex` or `base64`), `ZOOM_RTMS_SIGNALING_SEQUENCE`, `ZOOM_RTMS_PCM_ORDER` (`le` or `be`): the protocol's open points, when they must differ from the defaults.
 */
import { readFileSync } from 'node:fs';
import { LiveKitPublisher } from './publisher.js';
import { ZoomMediaWorker } from './server.js';

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

function secretFile(name: string): string {
  const value = readFileSync(need(name), 'utf8').trim();
  if (value === '') throw new Error(`the file ${name} names is empty`);
  return value;
}

function oneOf<T extends string>(name: string, words: readonly T[]): T | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  if (!words.includes(value as T)) throw new Error(`${name} must be one of ${words.join(', ')}`);
  return value as T;
}

async function main(): Promise<void> {
  const [host, port] = (process.env.ZOOM_MEDIA_LISTEN ?? '0.0.0.0:8790').split(':');
  const sequence = process.env.ZOOM_RTMS_SIGNALING_SEQUENCE;
  const worker = new ZoomMediaWorker({
    workerId: need('ZOOM_MEDIA_WORKER_ID'),
    slots: Number(process.env.ZOOM_MEDIA_SLOTS ?? '4'),
    clientToken: secretFile('ZOOM_MEDIA_CLIENT_TOKEN_FILE'),
    clientId: need('ZOOM_CLIENT_ID'),
    clientSecret: secretFile('ZOOM_CLIENT_SECRET_FILE'),
    webhookSecret: secretFile('ZOOM_WEBHOOK_SECRET_FILE'),
    listen: { host: host ?? '0.0.0.0', port: Number(port ?? '8790') },
    stateDir: process.env.ZOOM_MEDIA_STATE_DIR ?? '/var/lib/zoom-media',
    reportOrigin: need('ZOOM_MEDIA_REPORT_ORIGIN'),
    reportVia: process.env.ZOOM_MEDIA_REPORT_VIA || undefined,
    livekitUrl: process.env.ZOOM_MEDIA_LIVEKIT_URL || undefined,
    makePublisher: (livekit) => new LiveKitPublisher(livekit),
    stream: {
      signatureEncoding: oneOf('ZOOM_RTMS_SIGNATURE_ENCODING', ['hex', 'base64'] as const),
      signalingSequence: sequence === undefined || sequence === '' ? undefined : Number(sequence),
      pcmByteOrder: oneOf('ZOOM_RTMS_PCM_ORDER', ['le', 'be'] as const),
    },
    logger: { info: (line) => console.log(line), warn: (line) => console.log(line) },
  });
  await worker.start();
  const stop = (): void => {
    void worker.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: 'zoom_media', state: 'failed_to_start', code: error instanceof Error ? error.message : 'error' }));
  process.exit(1);
});
