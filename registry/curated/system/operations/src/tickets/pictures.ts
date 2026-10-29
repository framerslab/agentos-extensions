/**
 * @fileoverview Pictures (D18): an upload reads at most 5 MB, has its leading bytes checked against
 * PNG, JPEG or WebP and against the declared type, waits its turn for the process's one decode (a
 * second waits up to 10 seconds, then `busy`), is decoded by sharp under `failOn: 'warning'`,
 * 50,000,000 input pixels and `autoOrient`, and is written again as WebP at most 2,000 pixels on
 * its long side with no EXIF, ICC, XMP or other metadata, at most 1 MB, into `ops_attachments`,
 * unattached until a message names it (an upload no message names within an hour is swept). A
 * person holds at most 20 such uploads made within that hour (`picturesUnattachedMax`): the next is
 * refused `upload_quota` with `retryAfter` before it is decoded, so one account fills no table and
 * holds no decode; staff uploads are not counted. A
 * picture is served to its request's person and to staff, with the headers the product's route
 * sets from `PICTURE_HEADERS`. sharp is an optional peer loaded at the first decode, never at this
 * module's import; a load that fails is thrown to the caller as `PictureDecoderUnavailable`, never
 * answered as `not_an_image`, and is tried again at the next upload.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsPerson, OpsPicture, OpsRefusal, OpsStaff } from '../contract.js';
import { newId } from '../store/ids.js';
import { actorKind } from './actors.js';
import type { DecodeBounds, DecodedPicture, PictureDecoder, TicketTables, TicketsCore } from './core.js';
import { checkUnattachedUploads } from './limits.js';
import { RefusedInside, notFound, refusable, refusal, refuseInside } from './refusals.js';
import { numberOf } from './states.js';

/** The headers a picture is served with (D18); the product's route sets them from the answer. */
export const PICTURE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
  'Cache-Control': 'no-store',
});

/** The media type every stored picture has. */
export const STORED_TYPE = 'image/webp';

/** The three types an upload may declare, each with the leading bytes that prove it. */
export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp';

const ascii = (bytes: Uint8Array, at: number, text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[at + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

/** The type the leading bytes prove, or null: PNG's eight-byte signature, JPEG's FF D8 FF, WebP's RIFF....WEBP. */
export function sniffPicture(bytes: Uint8Array): PictureType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG') && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  return null;
}

type SharpModule = typeof import('sharp');

let sharpModule: Promise<SharpModule> | null = null;

/** Thrown by an upload when the decoder itself cannot be loaded (sharp missing or broken): a fault for the caller, never `not_an_image`. */
export class PictureDecoderUnavailable extends Error {
  constructor(cause: unknown) {
    super('the picture decoder could not be loaded', { cause });
    this.name = 'PictureDecoderUnavailable';
  }
}

/** The WebP qualities tried in turn: the second when the first is past the output bound. */
const QUALITIES = [82, 55] as const;

/**
 * The default decoder: sharp under D18's settings. It throws what sharp throws for bytes it cannot
 * read or an image past the pixel bound, which the upload answers as `not_an_image`; the output
 * bound is the caller's to check.
 */
export const sharpDecoder: PictureDecoder = async (bytes, bounds) => {
  if (sharpModule === null) {
    sharpModule = import('sharp').catch((error: unknown) => {
      // The load failed: nothing is cached, so the next upload tries again, and the fault reaches the caller as one.
      sharpModule = null;
      throw new PictureDecoderUnavailable(error);
    });
  }
  const sharp = (await sharpModule).default;
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let last: DecodedPicture | null = null;
  for (const quality of QUALITIES) {
    const { data, info } = await sharp(input, { failOn: 'warning', limitInputPixels: bounds.inputPixelsMax, autoOrient: true })
      .resize({ width: bounds.longSideMax, height: bounds.longSideMax, fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    last = { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
    if (last.bytes.length <= bounds.outputBytesMax) return last;
  }
  return last as DecodedPicture;
};

interface Waiter {
  wake(): void;
  cancelled: boolean;
}

/** The process's one decode at a time (D18): a second upload waits its turn up to the wait bound, then is refused. */
export class DecodeGate {
  private busy = false;
  private readonly waiters: Waiter[] = [];

  /** Takes the gate, or answers false once `waitMs` have passed without it. */
  acquire(waitMs: number): Promise<boolean> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        cancelled: false,
        wake() {
          if (timer !== undefined) clearTimeout(timer);
          resolve(true);
        },
      };
      timer = setTimeout(() => {
        waiter.cancelled = true;
        resolve(false);
      }, waitMs);
      timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /** Hands the gate to the next waiter still waiting, or frees it. */
  release(): void {
    for (;;) {
      const next = this.waiters.shift();
      if (next === undefined) {
        this.busy = false;
        return;
      }
      if (!next.cancelled) {
        next.wake();
        return;
      }
    }
  }
}

interface StoredPictureRow {
  readonly id: string;
  readonly media_type: string;
  readonly bytes: Uint8Array | Buffer;
  readonly width: number | string;
  readonly height: number | string;
  readonly uploaded_by: string | null;
  readonly ticket_id: string | null;
  readonly account_id: string | null;
}

/** The pictures' functions over `core`, with the process's decode gate. */
export function createPictures(core: TicketsCore, decode: PictureDecoder) {
  const gate = new DecodeGate();
  const { db, limits, tables } = core;
  const bounds: DecodeBounds = {
    inputPixelsMax: limits.pictureInputPixelsMax,
    longSideMax: limits.pictureLongSideMax,
    outputBytesMax: limits.pictureOutputBytesMax,
  };

  return {
    async upload(actor: OpsPerson | OpsStaff, bytes: Uint8Array, declaredType: string): Promise<{ readonly id: string } | OpsRefusal> {
      const kind = actorKind(actor);
      if (!(bytes instanceof Uint8Array) || kind === null) return refusal('refused', 400);
      if (bytes.length > limits.pictureBytesMax) return refusal('too_large', 413);
      const sniffed = sniffPicture(bytes);
      if (sniffed === null || sniffed !== declaredType) return refusal('not_an_image', 415);
      if (!(await gate.acquire(limits.pictureWaitMs))) return refusal('busy', 503);
      let decoded: DecodedPicture;
      try {
        if (kind === 'person') {
          // The person's unattached uploads of the hour, read before the decode: an account past the bound writes no row and runs no decode, holding the gate for this one read (D18).
          // Read inside the gate, not before it, so uploads take the gate in the order they came, as a read of the database before it would not.
          const quota = await checkUnattachedUploads(db, tables.attachments, actor.accountId, core.now(), limits);
          if (quota !== null) return quota;
        }
        try {
          decoded = await decode(bytes, bounds);
        } catch (error) {
          // The decoder itself could not be loaded: a fault for the caller, not a verdict on the bytes.
          if (error instanceof PictureDecoderUnavailable) throw error;
          return refusal('not_an_image', 415);
        }
      } finally {
        gate.release();
      }
      if (!(decoded.bytes instanceof Uint8Array) || !Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height)) return refusal('not_an_image', 415);
      if (decoded.bytes.length > limits.pictureOutputBytesMax) return refusal('too_large', 413);
      const id = newId('pic');
      const insert = `INSERT INTO ${tables.attachments} (id, ticket_id, message_id, uploaded_by, media_type, bytes, width, height, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?)`;
      if (kind === 'staff') {
        // A staff upload carries no uploader, so no account's deletion can leave it behind.
        await db.run(insert, [id, null, STORED_TYPE, decoded.bytes, decoded.width, decoded.height, core.now()]);
        return { id };
      }
      // A person's upload lands under the account's lock with its liveness read fresh, as open does: a deletion that committed while the decoder ran, or an account the directory marks deleting, leaves no picture of the account behind (D18, D20).
      return refusable(() =>
        db.transaction(async (trx) => {
          if (!(await core.lockLiveAccount(trx, actor.accountId))) refuseInside('not_found', 404);
          // Read again under the account's lock: two uploads of one person decoded at once take the last place in turn.
          const now = core.now();
          const quota = await checkUnattachedUploads(trx, tables.attachments, actor.accountId, now, limits);
          if (quota !== null) throw new RefusedInside(quota);
          await trx.run(insert, [id, actor.accountId, STORED_TYPE, decoded.bytes, decoded.width, decoded.height, now]);
          return { id };
        }),
      );
    },

    async picture(actor: OpsPerson | OpsStaff, id: string): Promise<OpsPicture | OpsRefusal> {
      const kind = actorKind(actor);
      if (typeof id !== 'string' || id.length === 0 || id.length > 64 || kind === null) return notFound();
      const row = await db.get<StoredPictureRow>(
        `SELECT a.id, a.media_type, a.bytes, a.width, a.height, a.uploaded_by, a.ticket_id, t.account_id
         FROM ${tables.attachments} a LEFT JOIN ${tables.tickets} t ON t.id = a.ticket_id WHERE a.id = ?`,
        [id],
      );
      if (row === null) return notFound();
      if (kind === 'person') {
        const owner = row.ticket_id === null ? row.uploaded_by : row.account_id;
        if (owner !== actor.accountId) return notFound();
      }
      return { id: row.id, mediaType: row.media_type, bytes: new Uint8Array(row.bytes), width: numberOf(row.width), height: numberOf(row.height) };
    },
  };
}

/**
 * Attaches `ids` to the message `messageId` of `ticketId` through `writer`, inside the write's
 * transaction: each must be unattached and, for a person, their own upload; for staff, an upload
 * with no uploader. A picture another account uploaded or one already attached refuses the write
 * as `not_found`, and the transaction rolls back (D18).
 */
export async function attachPictures(writer: StorageAdapter, tables: TicketTables, ids: readonly string[], ticketId: string, messageId: string, uploader: string | null): Promise<void> {
  for (const id of ids) {
    const result =
      uploader === null
        ? await writer.run(
            `UPDATE ${tables.attachments} SET ticket_id = ?, message_id = ? WHERE id = ? AND uploaded_by IS NULL AND ticket_id IS NULL AND message_id IS NULL`,
            [ticketId, messageId, id],
          )
        : await writer.run(
            `UPDATE ${tables.attachments} SET ticket_id = ?, message_id = ? WHERE id = ? AND uploaded_by = ? AND ticket_id IS NULL AND message_id IS NULL`,
            [ticketId, messageId, id, uploader],
          );
    if (Number(result.changes) !== 1) refuseInside('not_found', 404);
  }
}
