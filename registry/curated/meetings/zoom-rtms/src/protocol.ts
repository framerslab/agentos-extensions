/**
 * The protocol between the provider (in the host's process) and the media worker (a service beside the host's agent):
 * the worker's HTTP API and the reports it posts to the host's events route under a run's own token. The worker holds
 * each run's two connections to Zoom and its publisher in the run's LiveKit room; the provider never touches media.
 *
 * @module
 */
import type { MeetingLeaveReason } from '@framers/agentos/io/channels/meetings';
import { z } from 'zod';

/**
 * The reasons a run leaves with, as AgentOS's meeting channel names them (`MeetingLeaveReason`): the reason a leave
 * carries to the worker and the reason its report of the run's end gives back. The list holds every reason the channel
 * names, so the worker can be told to leave with any of them and report it.
 */
export const ZOOM_LEAVE_REASONS = [
  'ended', 'stopped_by_participant', 'stopped_by_owner', 'not_admitted', 'notice_failed', 'stop_monitor_failed', 'alone',
  'allowance', 'cap', 'page_away', 'declined', 'no_capacity', 'permission_denied', 'stt_failed', 'crashed',
] as const satisfies readonly MeetingLeaveReason[];
/** A reason a run leaves with: one of {@link ZOOM_LEAVE_REASONS}. */
export type ZoomLeaveReason = (typeof ZOOM_LEAVE_REASONS)[number];

/** Takes `true` alone: the alias below fails the build when the channel names a leave reason the list lacks. */
type Holds<T extends true> = T;
type EveryLeaveReasonListed = Holds<[Exclude<MeetingLeaveReason, ZoomLeaveReason>] extends [never] ? true : false>;

/**
 * The words a report's `message` carries: why a run ended, in the worker's own words, never a word of the meeting.
 * `host_did_not_allow`: no stream came after Zoom accepted the start. `handshake_refused`: Zoom refused a handshake of
 * the stream. `stream_lost`: Zoom gave up on a connection, or one was lost beyond its window. `worker_stopped` and
 * `worker_restarted`: the worker itself stopped, or started again with the run in its state files.
 */
export const ZOOM_END_WORDS = ['host_did_not_allow', 'handshake_refused', 'stream_lost', 'worker_stopped', 'worker_restarted'] as const;
/** A word of {@link ZOOM_END_WORDS}. */
export type ZoomEndWord = (typeof ZOOM_END_WORDS)[number];

/** `POST /runs`: a run the provider is about to start a stream for. */
export const ZoomStartRun = z.object({
  runId: z.string().min(1).max(64),
  connectionGeneration: z.string().min(1),
  connectionCreatedAt: z.number().int().nonnegative(),
  runGeneration: z.string().min(1),
  requestedAt: z.number().int().nonnegative(),
  /** The meeting's number, as the join link carries it. */
  meetingNumber: z.string().regex(/^\d{9,13}$/),
  /** The Zoom user the stream is started for: the `operator_id` of Zoom's started event. */
  zoomUserId: z.string().min(1).max(64),
  livekit: z.object({ url: z.string().url(), token: z.string().min(1), identity: z.string().min(1) }),
  /** The per-run bearer the worker presents on every report. */
  workerToken: z.string().min(16),
  /** Where the worker posts the run's reports. */
  reportUrl: z.string().url(),
  /** The run's longest life from now, in milliseconds; the worker closes the stream itself a minute after it. */
  totalMs: z.number().int().positive(),
});
/** A start, as {@link ZoomStartRun} parses it. */
export type ZoomStartRun = z.infer<typeof ZoomStartRun>;

/**
 * `POST /runs/:id/command`. There is no chat command: the provider declares `postsChat: false`. `withdraw` takes back a
 * run whose start failed after the worker accepted it: the worker ends it as it ends a killed run and posts nothing more
 * of it, its end included, since the host settles a failed dispatch itself.
 */
export const ZoomCommand = z.object({
  name: z.enum(['startCapture', 'suspendCapture', 'leave', 'kill', 'withdraw', 'confirmClosed']),
  /** Why the run leaves, on `leave` and `confirmClosed`: one of {@link ZOOM_LEAVE_REASONS}, and nothing else. */
  reason: z.enum(ZOOM_LEAVE_REASONS).optional(),
});
/** A command, as {@link ZoomCommand} parses it. */
export type ZoomCommand = z.infer<typeof ZoomCommand>;

/**
 * The durations the supplier's charge for a stream rests on: the seconds the stream ran and the seconds its audio was
 * captured into the room. `final` is true on the measurement taken once the stream's closure is confirmed.
 */
export const ZoomSupplierUsage = z.object({
  streamSeconds: z.number().nonnegative(),
  captureSeconds: z.number().nonnegative(),
  final: z.boolean().optional(),
});
/** A command's answer. `closed` is true when a leave closed the stream over the worker's own connection to Zoom. */
export const ZoomCommandAnswer = z.object({ closed: z.boolean(), supplierUsage: ZoomSupplierUsage.optional() });
/** A command's answer, as {@link ZoomCommandAnswer} parses it. */
export type ZoomCommandAnswer = z.infer<typeof ZoomCommandAnswer>;

/** A run's states on the media worker, as {@link ZoomRunStatus} reports them. */
export const ZOOM_RUN_STATES = ['waiting', 'streaming', 'reconnecting', 'ending', 'ended'] as const;

/** `GET /runs`, and the answer of `POST /runs`. `seconds` counts from the stream's first handshake; 0 before it. */
export const ZoomRunStatus = z.object({
  runId: z.string(),
  state: z.enum(ZOOM_RUN_STATES),
  startedAt: z.number(),
  seconds: z.number().int().nonnegative(),
  supplierUsage: ZoomSupplierUsage.optional(),
});
/** A run's status, as {@link ZoomRunStatus} parses it. */
export type ZoomRunStatus = z.infer<typeof ZoomRunStatus>;

/** `GET /capacity`. */
export const ZoomCapacity = z.object({ workerId: z.string(), slots: z.number().int(), busy: z.number().int() });
/** A worker's capacity, as {@link ZoomCapacity} parses it. */
export type ZoomCapacity = z.infer<typeof ZoomCapacity>;

/** The events the worker reports. It reports no participant and no chat: it reads neither. */
export const ZOOM_REPORT_EVENTS = ['in_call', 'notice_posted', 'monitor_heartbeat', 'capture_started', 'capture_suspended', 'stop_command', 'left', 'done', 'crashed', 'usage', 'error'] as const;

/** What the worker posts to a run's report address, under `Authorization: Bearer <workerToken>`. */
export const ZoomReportPost = z.object({
  type: z.literal('report'),
  runId: z.string().min(1),
  workerId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  event: z.enum(ZOOM_REPORT_EVENTS),
  at: z.number().int().nonnegative(),
  data: z
    .object({
      /** Why the run left, on `left`: one of {@link ZOOM_LEAVE_REASONS}, and nothing else. */
      reason: z.enum(ZOOM_LEAVE_REASONS).optional(),
      seconds: z.number().int().nonnegative().optional(),
      supplierUsage: ZoomSupplierUsage.optional(),
      /** A word of {@link ZOOM_END_WORDS}, and nothing else: never a word of the meeting. */
      message: z.enum(ZOOM_END_WORDS).optional(),
    })
    .optional(),
});
/** A report, as {@link ZoomReportPost} parses it. */
export type ZoomReportPost = z.infer<typeof ZoomReportPost>;

/** A stable event id for a worker's report: the run, the worker's sequence number and the event. */
export function zoomReportEventId(runId: string, seq: number, event: string): string {
  return `zoom-rtms:${runId}:${seq}:${event}`;
}

/** A stable event id for an event read from one of Zoom's webhooks: the run, the stream, what happened and Zoom's own time of it. */
export function zoomWebhookEventId(runId: string, streamId: string, kind: 'started' | 'stopped', at: number): string {
  return `zoom-rtms:${runId}:${streamId}:${kind}:${at}`;
}
