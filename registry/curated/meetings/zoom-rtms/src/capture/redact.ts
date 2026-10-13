/**
 * Turns what the capture tool recorded of a real stream into a fixture a public repository can hold: every identifier
 * replaced by a fixed one, every address by the local test server's, every person by "Speaker A", "Speaker B" in the
 * order they first appear, every timestamp moved by one offset so the gaps stand, and of each message only the fields
 * this list names; a message whose type the list does not know keeps its type and nothing else. The audio is kept for
 * its first packets (a synthetic tone from the test meeting), or silenced.
 *
 * @module
 */

/** One frame the tool recorded on a connection: its time since the started event, whether it was binary, and its content. */
export interface RawEntry {
  /** Milliseconds since the started event reached the tool. */
  ms: number;
  binary: boolean;
  text?: string;
  base64?: string;
}

/** The protocol parameters the capture ran with: the signature's encoding, the first signaling sequence and the samples' byte order. */
export interface CaptureProtocol {
  signatureEncoding: 'hex' | 'base64';
  signalingSequence: number;
  pcmByteOrder: 'le' | 'be';
}

/** What the tool recorded of one stream: the protocol parameters, the webhooks, and every frame of the signaling and media connections. */
export interface RawCapture {
  protocol: CaptureProtocol;
  webhooks: Array<{ ms: number; body: string }>;
  signaling: RawEntry[];
  media: RawEntry[];
}

/** A media frame in a fixture: a message, or a binary frame kept as base64. */
export type FixtureMedia = { ms: number; message: Record<string, unknown> } | { ms: number; binaryBase64: string };

/** A recorded stream as the repository holds it: a note, the protocol parameters, and the webhooks, signaling and media frames with every identifier, address and name replaced. */
export interface Fixture {
  note: string;
  protocol: CaptureProtocol;
  webhooks: Array<{ ms: number; event: string; event_ts: number; payload: Record<string, unknown> }>;
  signaling: Array<{ ms: number; message: Record<string, unknown> }>;
  media: FixtureMedia[];
}

/** The fixed identifiers a fixture carries in place of the real ones. */
export const FIXTURE_IDS = {
  meetingUuid: 'fixture-meeting-uuid',
  streamId: 'fixture-stream-id',
  operatorId: 'fixture-operator',
  accountId: 'fixture-account',
  sessionId: 'fixture-session',
  meetingId: 80_000_000_001,
} as const;

const SIGNALING_URL = 'wss://fake-rtms.test/signaling';
const MEDIA_URL = 'wss://fake-rtms.test/media';
/** Where the fixture's clock starts: the started event's time is moved here, and every other time by the same offset. */
const BASE = 1_700_000_000_000;

type Json = Record<string, unknown>;

function parse(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined;
  try {
    const json: unknown = JSON.parse(text);
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Json) : undefined;
  } catch {
    return undefined;
  }
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const obj = (value: unknown): Json => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {});

/** Keeps the numeric fields named, each under its own name. */
function numbers(source: Json, names: readonly string[]): Json {
  const kept: Json = {};
  for (const name of names) {
    const value = num(source[name]);
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

function zeros(base64: string): string {
  return Buffer.alloc(Buffer.from(base64, 'base64').length).toString('base64');
}

/** Turns a raw capture into a fixture: identifiers, addresses, names and timestamps replaced as the module says, each message cut to the fields the list names, and the audio bounded or silenced. */
export function redactCapture(raw: RawCapture, options: { maxAudioPackets?: number; silenceAudio?: boolean } = {}): Fixture {
  const maxAudio = options.maxAudioPackets ?? 150;
  const webhooks = raw.webhooks.flatMap((entry) => {
    const json = parse(entry.body);
    return json === undefined || typeof json.event !== 'string' ? [] : [{ ms: entry.ms, event: json.event, eventTs: num(json.event_ts), payload: obj(json.payload) }];
  });
  const signaling = raw.signaling.flatMap((entry) => {
    const json = parse(entry.text);
    return json === undefined ? [] : [{ ms: entry.ms, json }];
  });

  // one offset for every timestamp: the started event's own time, or the first time seen
  const firstSeen = [...signaling.map((entry) => num(entry.json.timestamp) ?? num(obj(entry.json.event).timestamp))].find((value) => value !== undefined);
  const origin = webhooks.find((webhook) => webhook.event === 'meeting.rtms_started')?.eventTs ?? firstSeen ?? BASE;
  const shift = (value: unknown): number | undefined => {
    const time = num(value);
    return time === undefined ? undefined : time - origin + BASE;
  };
  const withTime = (kept: Json, value: unknown, name = 'timestamp'): Json => {
    const time = shift(value);
    return time === undefined ? kept : { ...kept, [name]: time };
  };

  // people, by the order they first appear on either connection
  const people = new Map<number, { id: number; name: string }>();
  const person = (userId: unknown): { id: number; name: string } | undefined => {
    const id = num(userId);
    if (id === undefined || id === 0) return undefined;
    let known = people.get(id);
    if (known === undefined) {
      const index = people.size;
      known = { id: 1001 + index, name: `Speaker ${String.fromCharCode(65 + (index % 26))}${index >= 26 ? String(Math.floor(index / 26)) : ''}` };
      people.set(id, known);
    }
    return known;
  };
  const inOrder = [
    ...signaling.map((entry) => ({ ms: entry.ms, json: entry.json })),
    ...raw.media.flatMap((entry) => {
      const json = entry.binary ? undefined : parse(entry.text);
      return json === undefined ? [] : [{ ms: entry.ms, json }];
    }),
  ].sort((a, b) => a.ms - b.ms);
  for (const entry of inOrder) {
    const event = obj(entry.json.event);
    person(event.user_id);
    if (Array.isArray(event.participants)) for (const participant of event.participants) person(obj(participant).user_id);
    person(obj(entry.json.content).user_id);
  }
  const named = (userId: unknown): Json => {
    const known = person(userId);
    return known === undefined ? {} : { user_id: known.id, user_name: known.name };
  };

  const signalingMessage = (json: Json): Json => {
    const type = num(json.msg_type);
    switch (type) {
      case 2: {
        const urls = obj(obj(json.media_server).server_urls);
        const status = num(json.status_code) ?? -1;
        return {
          ...numbers(json, ['msg_type', 'protocol_version', 'sequence', 'status_code']),
          reason: status === 0 ? '' : 'refused',
          media_server: { server_urls: { ...(urls.audio === undefined ? {} : { audio: MEDIA_URL }), ...(urls.all === undefined ? {} : { all: MEDIA_URL }) } },
        };
      }
      case 6: {
        const event = obj(json.event);
        const eventType = num(event.event_type);
        const kept: Json = withTime(numbers(event, ['event_type']), event.timestamp);
        if (eventType === 2) Object.assign(kept, named(event.user_id));
        if ((eventType === 3 || eventType === 4) && Array.isArray(event.participants)) kept.participants = event.participants.map((participant) => named(obj(participant).user_id));
        return { msg_type: 6, event: kept };
      }
      case 8:
        return withTime(numbers(json, ['msg_type', 'state', 'reason']), json.timestamp);
      case 9:
        return { ...withTime(numbers(json, ['msg_type', 'state', 'stop_reason', 'reason']), json.timestamp), rtms_session_id: FIXTURE_IDS.sessionId };
      case 12:
        return withTime({ msg_type: 12 }, json.timestamp);
      case 22:
        return { msg_type: 22, rtms_stream_id: FIXTURE_IDS.streamId, ...numbers(json, ['status_code']), reason: '', ...withTime({}, json.timestamp) };
      default:
        return { msg_type: type ?? -1 };
    }
  };

  let audioKept = 0;
  const media: FixtureMedia[] = [];
  for (const entry of raw.media) {
    if (entry.binary) {
      if (entry.base64 === undefined || audioKept >= maxAudio) continue;
      audioKept += 1;
      media.push({ ms: entry.ms, binaryBase64: options.silenceAudio ? zeros(entry.base64) : entry.base64 });
      continue;
    }
    const json = parse(entry.text);
    if (json === undefined) continue;
    const type = num(json.msg_type);
    if (type === 4) {
      media.push({ ms: entry.ms, message: { ...numbers(json, ['msg_type', 'protocol_version', 'status_code', 'sequence']), reason: '', payload_encrypted: json.payload_encrypted === true, media_params: { audio: numbers(obj(obj(json.media_params).audio), ['content_type', 'sample_rate', 'channel', 'codec', 'data_opt', 'send_rate']) } } });
    } else if (type === 14) {
      const content = obj(json.content);
      if (typeof content.data !== 'string' || audioKept >= maxAudio) continue;
      audioKept += 1;
      const known = person(content.user_id);
      media.push({
        ms: entry.ms,
        message: {
          msg_type: 14,
          content: { user_id: known?.id ?? 0, ...(known !== undefined && typeof content.user_name === 'string' ? { user_name: known.name } : {}), data: options.silenceAudio ? zeros(content.data) : content.data, ...numbers(content, ['length']), ...withTime({}, content.timestamp) },
        },
      });
    } else if (type === 12) {
      media.push({ ms: entry.ms, message: withTime({ msg_type: 12 }, json.timestamp) });
    } else {
      media.push({ ms: entry.ms, message: { msg_type: type ?? -1 } });
    }
  }

  return {
    note: "Recorded by the pack's capture tool from a test meeting in the maintainers' own account whose only sound was a synthetic tone, then redacted: ids, addresses, names and times are not the meeting's.",
    protocol: raw.protocol,
    webhooks: webhooks.map((webhook) => ({
      ms: webhook.ms,
      event: webhook.event,
      event_ts: shift(webhook.eventTs) ?? BASE,
      payload:
        webhook.event === 'meeting.rtms_started'
          ? { meeting_uuid: FIXTURE_IDS.meetingUuid, operator_id: FIXTURE_IDS.operatorId, rtms_stream_id: FIXTURE_IDS.streamId, meeting_id: FIXTURE_IDS.meetingId, account_id: FIXTURE_IDS.accountId, is_original_host: webhook.payload.is_original_host === true, server_urls: SIGNALING_URL }
          : { meeting_uuid: FIXTURE_IDS.meetingUuid, rtms_stream_id: FIXTURE_IDS.streamId, ...numbers(webhook.payload, ['stop_reason']) },
    })),
    signaling: signaling.map((entry) => ({ ms: entry.ms, message: signalingMessage(entry.json) })),
    media,
  };
}
