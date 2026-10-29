/**
 * @fileoverview `./tickets`: `createTickets`, the support requests (D8 to D21, D46). The module is
 * built only when the options hold the `tickets` host (D48): the person's functions, pictures,
 * staff's functions, system messages, the deletions, the stream, and the mail and bell outboxes'
 * runs. Beside the contract it answers `closeAll()` for `stop()`, `deleteAccount` for the root's
 * account hook and the count of open streams. sharp and the storage adapter are optional peers
 * loaded at the first call that needs them, never at this module's import, so the pack guard and
 * a product can import the entry on its own.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsContext } from '../context.js';
import type { OpsOutboxRun, OpsPerson, OpsRefusal, OpsStaff, OpsStream, Tickets } from '../contract.js';
import { actorKind } from './actors.js';
import { createCore, type StreamTiming, type TicketsDeps } from './core.js';
import { createDeletions } from './delete.js';
import { notifyDue, sendDue } from './outbox.js';
import { createPerson } from './person.js';
import { createPictures, sharpDecoder } from './pictures.js';
import { notFound, refusal } from './refusals.js';
import { createStaff } from './staff.js';
import { loadOwnTicket, loadTicket } from './states.js';
import { STREAM_COMMENT_MS, STREAM_LIVENESS_MS, STREAM_READ_MS, STREAM_READ_SQLITE_MS, StreamRegistry, createStreams } from './stream.js';
import { createSystemMessages } from './system.js';

export type { AlertSender, DecodeBounds, DecodedPicture, PictureDecoder, StreamTiming, TicketsDeps } from './core.js';
export { actorKind, isPerson, isStaff, type ActorKind } from './actors.js';
export { PICTURE_HEADERS, PictureDecoderUnavailable } from './pictures.js';
export { OpsRefused } from './refusals.js';
export type { ExportedMessage, ExportedRequest } from './export.js';

/** What `createTickets` answers: the contract's `Tickets`, and what the root and `stop()` need beside it. */
export interface TicketsModule extends Tickets {
  /** Deletes every request of the account inside the host's own transaction (D20); the root's `deleteAccount` calls it. */
  deleteAccount(trx: StorageAdapter, accountId: string): Promise<void>;
  /** Ends every stream with a final comment and stops listening (D13, D47); `stop()` calls it. */
  closeAll(): void;
  /** How many streams this process holds open. */
  readonly streams: number;
}

/**
 * Builds the support requests over `context`, whose options hold the `tickets` host (D48). `deps`
 * carries the team alert's sender, which the root passes, and the test-only overrides: the random
 * source of the anonymous id, the picture decoder and the stream's cadence.
 */
export function createTickets(context: OpsContext, deps: TicketsDeps = {}): TicketsModule {
  const registry = new StreamRegistry();
  const core = createCore(context, deps, registry);
  const timing: StreamTiming = {
    commentMs: deps.timing?.commentMs ?? STREAM_COMMENT_MS,
    readMs: deps.timing?.readMs ?? (core.postgres ? STREAM_READ_MS : STREAM_READ_SQLITE_MS),
    readWithoutListenerMs: deps.timing?.readWithoutListenerMs ?? STREAM_READ_SQLITE_MS,
    livenessMs: deps.timing?.livenessMs ?? STREAM_LIVENESS_MS,
    lifeMs: deps.timing?.lifeMs ?? core.limits.streamLifeMs,
  };
  const streams = createStreams(core, registry, timing);
  const person = createPerson(core);
  const pictures = createPictures(core, deps.decode ?? sharpDecoder);
  const staff = createStaff(core);
  const system = createSystemMessages(core);
  const deletions = createDeletions(core);
  // One run of each outbox at a time a process: a call while one runs joins it, so overlapping timers deliver each notice once (D14, D15); the minute tick's lock keeps processes apart, and the mail's idempotency key is the product's own guard.
  let mailRun: Promise<OpsOutboxRun> | null = null;
  let bellRun: Promise<number> | null = null;

  return {
    ...person,
    ...pictures,
    ...staff,
    ...system,
    remove: deletions.remove,
    staffRemove: deletions.staffRemove,
    hangup: deletions.hangup,
    deleteAccount: deletions.deleteAccount,
    async stream(actor: OpsPerson | OpsStaff, id: string, lastEventId?: string): Promise<OpsStream | OpsRefusal> {
      const kind = actorKind(actor);
      if (kind === null) return refusal('refused', 400);
      // The person's own request alone; staff may open the stream of any request (D13). Neither bound is read before the row, so a request that is not the person's answers not_found whatever the process holds (D4).
      const row = kind === 'staff' ? await loadTicket(core.db, core.tables.tickets, id) : await loadOwnTicket(core.db, core.tables.tickets, id, actor.accountId);
      if (row === null) return notFound();
      return streams.open(actor, row, lastEventId);
    },
    sendDue(nowMs) {
      if (mailRun === null) {
        mailRun = sendDue(core, nowMs).finally(() => {
          mailRun = null;
        });
      }
      return mailRun;
    },
    notifyDue(nowMs) {
      if (bellRun === null) {
        bellRun = notifyDue(core, nowMs).finally(() => {
          bellRun = null;
        });
      }
      return bellRun;
    },
    closeAll: () => streams.closeAll(),
    get streams() {
      return registry.size;
    },
  };
}
