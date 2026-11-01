import { z } from 'zod';

/** The platforms the browser bot joins. */
export const PLATFORMS = ['google_meet', 'microsoft_teams'] as const;

/**
 * A run's stop phrase: 2 to 80 characters, and at least 2 once each run of whitespace is folded to one space and the ends
 * are trimmed, as the bot compares it with a message (`image/src/stop-phrase.ts`). A blank phrase would match no message,
 * and its run would have no stop in the chat.
 */
const StopPhrase = z.string().min(2).max(80).refine((phrase) => phrase.replace(/\s+/g, ' ').trim().length >= 2, 'the stop phrase is blank');

/** The job the scheduler sends a container as the channel's first message. */
export const JobMessage = z.object({
  type: z.literal('job'),
  runId: z.string().min(1),
  platform: z.enum(PLATFORMS),
  meetingUrl: z.string().url(),
  botName: z.string().min(1).max(80),
  notice: z.object({ text: z.string().min(1).max(2000), version: z.string(), lateArrivalText: z.string().min(1).max(500) }),
  stopPhrase: StopPhrase,
  limits: z.object({ waitingRoomMs: z.number().int().positive(), aloneMs: z.number().int().positive(), totalMs: z.number().int().positive() }),
  livekit: z.object({ url: z.string().url(), token: z.string().min(1), identity: z.string().min(1) }),
  /** The profile directory inside the container (Meet), absent for a guest join (Teams). */
  profileDir: z.string().optional(),
  /**
   * `fixture` when the scheduler took the link's host from its test allowlist (`MEETING_RESOLVE_ALLOW`): the bot drives
   * the fixture page's adapter, whose network policy admits that host. A production scheduler's allowlist is empty, so
   * no production job carries it, and the product's `StartRunRequest` has no way to ask for it.
   */
  adapter: z.literal('fixture').optional(),
});
/** A job, as {@link JobMessage} parses it. */
export type JobMessage = z.infer<typeof JobMessage>;

/** The commands the scheduler relays to a container. */
export const CommandName = z.enum(['startCapture', 'suspendCapture', 'postChat', 'leave', 'kill']);
/** A command down the channel, with the id its acknowledgement names. */
export const CommandMessage = z.object({
  type: z.literal('command'),
  id: z.string().min(1),
  name: CommandName,
  text: z.string().max(2000).optional(),
  reason: z.string().optional(),
});
/** A command, as {@link CommandMessage} parses it. */
export type CommandMessage = z.infer<typeof CommandMessage>;

/** A container's answer to one command, by the command's id. */
export const AckMessage = z.object({ type: z.literal('ack'), id: z.string(), ok: z.boolean(), error: z.string().optional() });
/** An acknowledgement, as {@link AckMessage} parses it. */
export type AckMessage = z.infer<typeof AckMessage>;

/** The lifecycle events a container reports: the channel's provider event types. */
export const ReportEvent = z.enum(['joining', 'waiting_room', 'in_call', 'notice_posted', 'monitor_heartbeat', 'participant_joined', 'participant_left', 'chat_message', 'stop_command', 'capture_started', 'capture_suspended', 'left', 'done', 'crashed', 'usage', 'error']);
/** One report up the channel, numbered by the container's sequence. */
export const ReportMessage = z.object({
  type: z.literal('report'),
  seq: z.number().int().nonnegative(),
  event: ReportEvent,
  at: z.number().int().nonnegative(),
  data: z.object({
    reason: z.string().optional(),
    seconds: z.number().nonnegative().optional(),
    text: z.string().max(4000).optional(),
    sender: z.string().max(200).optional(),
    participantRef: z.string().max(200).optional(),
    participantCount: z.number().int().nonnegative().optional(),
    message: z.string().max(2000).optional(),
  }).optional(),
});
/** A report, as {@link ReportMessage} parses it. */
export type ReportMessage = z.infer<typeof ReportMessage>;

/** What the container sends the scheduler, or the scheduler the container. */
export const ChannelMessage = z.discriminatedUnion('type', [JobMessage, CommandMessage, AckMessage, ReportMessage]);
/** A channel message, as {@link ChannelMessage} parses it. */
export type ChannelMessage = z.infer<typeof ChannelMessage>;

/** A Google Meet identity's name: the folder under the profiles root, lower-case letters, digits and hyphens, 1 to 32. */
export const IDENTITY_NAME = /^[a-z0-9-]{1,32}$/;

/** The scheduler's `POST /runs` body, from the provider. */
export const StartRunRequest = z.object({
  runId: z.string().min(1),
  platform: z.enum(PLATFORMS),
  meetingUrl: z.string().url(),
  botName: z.string().min(1).max(80),
  notice: JobMessage.shape.notice,
  stopPhrase: StopPhrase,
  limits: JobMessage.shape.limits,
  livekit: JobMessage.shape.livekit,
  /** The per-run bearer the container presents and the scheduler forwards on every report. */
  workerToken: z.string().min(16),
  /** Where the scheduler posts the run's reports. */
  reportUrl: z.string().url(),
  /**
   * The Google Meet identity the run joins with: the folder the product's bot signs in as (the provider's
   * `identityFor`). Absent, the scheduler's configured default identity and that folder alone. Never read for a
   * Microsoft Teams run, which joins as a guest.
   */
  identity: z.string().regex(IDENTITY_NAME).optional(),
});
/** A start request, as {@link StartRunRequest} parses it. */
export type StartRunRequest = z.infer<typeof StartRunRequest>;

/** What the scheduler posts to `reportUrl`: one report, with the run id, under `Authorization: Bearer <workerToken>`. */
export const ReportPost = ReportMessage.extend({ runId: z.string().min(1), workerId: z.string().min(1) });
/** A forwarded report, as {@link ReportPost} parses it. */
export type ReportPost = z.infer<typeof ReportPost>;

/** One run as the scheduler's `GET /runs` lists it, and as `POST /runs` answers. */
export const RunStatus = z.object({ runId: z.string(), state: z.enum(['starting', 'running', 'leaving', 'exited']), startedAt: z.number(), seconds: z.number(), containerId: z.string().optional() });
/** A run's status, as {@link RunStatus} parses it. */
export type RunStatus = z.infer<typeof RunStatus>;
/** The scheduler's `GET /capacity` answer: the worker's slots, how many are busy, and whether it takes new runs. */
export const Capacity = z.object({ workerId: z.string(), slots: z.number().int(), busy: z.number().int(), paused: z.boolean() });
/** A worker's capacity, as {@link Capacity} parses it. */
export type Capacity = z.infer<typeof Capacity>;

/** A stable event id for a report: the run, the worker's sequence number and the event. */
export function reportEventId(runId: string, seq: number, event: string): string {
  return `browser:${runId}:${seq}:${event}`;
}
