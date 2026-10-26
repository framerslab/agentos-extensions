import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createContext } from '../src/context.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { createTickets, type PictureDecoder } from '../src/tickets/index.js';
import { PICTURE_HEADERS, PictureDecoderUnavailable } from '../src/tickets/pictures.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';
import { HUGE_PNG_HEIGHT, HUGE_PNG_WIDTH, hugePng, jpegWithOrientationAndGps, loadSharp, oversized, smallWebp, tinyGif, tinyPdf } from './helpers/pictures.js';
import { OTHER, PERSON, STAFF, countOf, ok, refusedAs, rowsOf } from './helpers/tickets.js';

const CONSENT = { version: '2026-10-25' };

describeBackends('pictures (D18)', (backend) => {
  let db: StorageAdapter;
  let prefix = '';

  beforeAll(async () => {
    db = await backend.open();
  });

  // Each case gets tables of its own, so one case's requests never reach another's quota, cooldown or counts.
  beforeEach(async () => {
    prefix = freshPrefix();
    await migrateOperations(db, { prefix });
  });

  afterEach(async () => {
    await dropOperationsTables(db, prefix);
  });

  afterAll(async () => {
    await db.close();
  });

  it('a JPEG with EXIF orientation 6 and a GPS tag comes back upright as WebP with no metadata, stored unattached with its uploader', async () => {
    const sharp = await loadSharp();
    const jpeg = await jpegWithOrientationAndGps();
    const before = await sharp(jpeg).metadata();
    expect([before.format, before.width, before.height, before.orientation]).toEqual(['jpeg', 8, 4, 6]);
    expect(before.exif).toBeDefined();

    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const uploaded = ok(await tickets.upload(PERSON, jpeg, 'image/jpeg'));
    const picture = ok(await tickets.picture(PERSON, uploaded.id));
    expect(picture.id).toBe(uploaded.id);
    expect(picture.mediaType).toBe('image/webp');
    expect([picture.width, picture.height]).toEqual([4, 8]);
    const after = await sharp(picture.bytes).metadata();
    expect([after.format, after.width, after.height]).toEqual(['webp', 4, 8]);
    expect(after.orientation).toBeUndefined();
    expect(after.exif).toBeUndefined();
    expect(after.icc).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(Buffer.from(picture.bytes).includes('Exif')).toBe(false);
    expect(Buffer.from(picture.bytes).includes('GPS')).toBe(false);

    const rows = await rowsOf(db, prefix, 'attachments', 'id = ?', [uploaded.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticket_id: null, message_id: null, uploaded_by: PERSON.accountId, media_type: 'image/webp' });
    expect([Number(rows[0]!.width), Number(rows[0]!.height)]).toEqual([4, 8]);
    expect(PICTURE_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'no-store',
    });
    refusedAs(await tickets.picture(OTHER, uploaded.id), 'not_found', 404);
    await ops.stop();
  });

  it('a 60-megapixel PNG under 5 MB, a JPEG named PNG, a GIF, a PDF and 5 MB and one byte are refused with their codes, and nothing is written', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const before = await countOf(db, prefix, 'attachments');
    const png = hugePng();
    expect(png.length).toBeLessThan(5 * 1024 * 1024);
    expect(HUGE_PNG_WIDTH * HUGE_PNG_HEIGHT).toBeGreaterThan(50_000_000);
    const sharp = await loadSharp();
    const meta = await sharp(png, { limitInputPixels: false }).metadata();
    expect([meta.width, meta.height]).toEqual([HUGE_PNG_WIDTH, HUGE_PNG_HEIGHT]);

    refusedAs(await tickets.upload(PERSON, png, 'image/png'), 'not_an_image', 415);
    refusedAs(await tickets.upload(PERSON, await jpegWithOrientationAndGps(), 'image/png'), 'not_an_image', 415);
    refusedAs(await tickets.upload(PERSON, tinyGif(), 'image/gif'), 'not_an_image', 415);
    refusedAs(await tickets.upload(PERSON, tinyPdf(), 'application/pdf'), 'not_an_image', 415);
    refusedAs(await tickets.upload(PERSON, oversized(), 'image/png'), 'too_large', 413);
    refusedAs(await tickets.upload(PERSON, new Uint8Array(0), 'image/png'), 'not_an_image', 415);
    expect(await countOf(db, prefix, 'attachments')).toBe(before);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain(PERSON.accountId);
    await ops.stop();
  });

  it('a second decode waits and answers busy after 10 seconds, and the first lands when its decode ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const webp = await smallWebp();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const decode: PictureDecoder = async () => {
        await held;
        return { bytes: webp, width: 6, height: 5 };
      };
      const fixture = fixtureOptions(db, { prefix }, fakeClock());
      const tickets = createTickets(createContext(fixture.options), { decode });
      const first = tickets.upload(PERSON, webp, 'image/webp');
      const second = tickets.upload(PERSON, webp, 'image/webp');
      await vi.advanceTimersByTimeAsync(10_000);
      refusedAs(await second, 'busy', 503);
      release();
      ok(await first);
      tickets.closeAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the first picture without consent answers consent_needed and with it records consent_at and the words' version, which a later picture leaves as they are", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const webp = await smallWebp();
    const first = ok(await tickets.upload(PERSON, webp, 'image/webp'));
    const ticketsBefore = await countOf(db, prefix, 'tickets');
    refusedAs(await tickets.open(PERSON, { category: 'bug', subject: 'A picture', body: 'see it', pictureIds: [first.id] }), 'consent_needed', 428);
    expect(await countOf(db, prefix, 'tickets')).toBe(ticketsBefore);
    expect((await rowsOf(db, prefix, 'attachments', 'id = ?', [first.id]))[0]).toMatchObject({ ticket_id: null, message_id: null });

    const openedAt = fixture.clock.now();
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'A picture', body: 'see it', pictureIds: [first.id], consent: CONSENT }));
    let row = (await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!;
    expect([Number(row.consent_at), row.consent_version]).toEqual([openedAt, CONSENT.version]);

    fixture.clock.advance(60_000);
    const second = ok(await tickets.upload(PERSON, webp, 'image/webp'));
    // The request holds the tick, so a later picture asks for nothing, and a later tick never replaces the first.
    ok(await tickets.write(PERSON, opened.id, { body: 'another, no tick', pictureIds: [second.id] }));
    const third = ok(await tickets.upload(PERSON, webp, 'image/webp'));
    ok(await tickets.write(PERSON, opened.id, { body: 'another', pictureIds: [third.id], consent: { version: 'a later version' } }));
    row = (await rowsOf(db, prefix, 'tickets', 'id = ?', [opened.id]))[0]!;
    expect([Number(row.consent_at), row.consent_version]).toEqual([openedAt, CONSENT.version]);

    // A request opened without a picture asks for the tick at its first picture, on a write.
    fixture.clock.advance(31_000);
    const plain = ok(await tickets.open(PERSON, { category: 'account', subject: 'No picture yet', body: 'words' }));
    const late = ok(await tickets.upload(PERSON, webp, 'image/webp'));
    refusedAs(await tickets.write(PERSON, plain.id, { body: 'a picture, no tick', pictureIds: [late.id] }), 'consent_needed', 428);
    expect((await rowsOf(db, prefix, 'attachments', 'id = ?', [late.id]))[0]).toMatchObject({ ticket_id: null, message_id: null });
    const tickedAt = fixture.clock.now();
    ok(await tickets.write(PERSON, plain.id, { body: 'a picture, ticked', pictureIds: [late.id], consent: { version: 'v2' } }));
    const plainRow = (await rowsOf(db, prefix, 'tickets', 'id = ?', [plain.id]))[0]!;
    expect([Number(plainRow.consent_at), plainRow.consent_version]).toEqual([tickedAt, 'v2']);
    // A message with no picture never asks for the tick.
    fixture.clock.advance(1_000);
    ok(await tickets.write(PERSON, opened.id, { body: 'words alone' }));
    const view = await tickets.get(PERSON, opened.id);
    expect(view?.messages.map((message) => message.pictures.length)).toEqual([1, 1, 1, 0]);
    expect(view?.messages[0]!.pictures[0]).toEqual({ id: first.id, width: 6, height: 5 });
    await ops.stop();
  });

  it("a picture uploaded before the request is attached by open; another account's upload, one already attached and more than 3 a message or 10 a request are refused; a staff upload carries no uploader", async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const webp = await smallWebp();
    const upload = async (actor = PERSON) => ok(await tickets.upload(actor, webp, 'image/webp')).id;

    const theirs = await upload(OTHER);
    refusedAs(await tickets.open(PERSON, { category: 'bug', subject: 'Not mine', body: 'x', pictureIds: [theirs], consent: CONSENT }), 'not_found', 404);
    expect(await countOf(db, prefix, 'tickets', 'account_id = ?', [PERSON.accountId])).toBe(0);

    const mine = await upload();
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'Mine', body: 'x', pictureIds: [mine], consent: CONSENT }));
    const attached = (await rowsOf(db, prefix, 'attachments', 'id = ?', [mine]))[0]!;
    expect(attached.ticket_id).toBe(opened.id);
    expect(typeof attached.message_id).toBe('string');
    fixture.clock.advance(31_000);
    refusedAs(await tickets.open(PERSON, { category: 'bug', subject: 'Again', body: 'x', pictureIds: [mine], consent: CONSENT }), 'not_found', 404);

    const four = [await upload(), await upload(), await upload(), await upload()];
    refusedAs(await tickets.write(PERSON, opened.id, { body: 'four', pictureIds: four, consent: CONSENT }), 'too_many_pictures', 409);
    ok(await tickets.write(PERSON, opened.id, { body: 'three', pictureIds: four.slice(0, 3) }));
    fixture.clock.advance(1_000);
    ok(await tickets.write(PERSON, opened.id, { body: 'three more', pictureIds: [await upload(), await upload(), await upload()] }));
    fixture.clock.advance(1_000);
    ok(await tickets.write(PERSON, opened.id, { body: 'three more again', pictureIds: [await upload(), await upload(), await upload()] }));
    fixture.clock.advance(1_000);
    expect(await countOf(db, prefix, 'attachments', 'ticket_id = ?', [opened.id])).toBe(10);
    refusedAs(await tickets.write(PERSON, opened.id, { body: 'the eleventh', pictureIds: [four[3]!] }), 'too_many_pictures', 409);

    const staffPicture = await upload(STAFF as never);
    expect((await rowsOf(db, prefix, 'attachments', 'id = ?', [staffPicture]))[0]!.uploaded_by).toBeNull();
    fixture.clock.advance(31_000);
    const second = ok(await tickets.open(PERSON, { category: 'account', subject: 'Second', body: 'x' }));
    ok(await tickets.reply(STAFF, second.id, { body: 'a picture from the team', pictureIds: [staffPicture] }));
    ok(await tickets.picture(PERSON, staffPicture));
    ok(await tickets.picture(STAFF, staffPicture));
    refusedAs(await tickets.picture(OTHER, staffPicture), 'not_found', 404);
    ok(await tickets.picture(STAFF, four[3]!));
    await ops.stop();
  });

  it("a request's picture bound holds from its first message: an open or a staff thread with more pictures than a request takes is refused, and nothing is written", async () => {
    const fixture = fixtureOptions(db, { prefix, limits: { picturesPerTicket: 1 } }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const webp = await smallWebp();
    const upload = async (actor = PERSON) => ok(await tickets.upload(actor, webp, 'image/webp')).id;
    const two = [await upload(), await upload()];
    refusedAs(await tickets.open(PERSON, { category: 'bug', subject: 'Two at once', body: 'x', pictureIds: two, consent: CONSENT }), 'too_many_pictures', 409);
    expect(await countOf(db, prefix, 'tickets')).toBe(0);
    const staffTwo = [await upload(STAFF as never), await upload(STAFF as never)];
    refusedAs(await tickets.writeTo(STAFF, PERSON.accountId, { category: 'account', subject: 'From the team', body: 'y', pictureIds: staffTwo }), 'too_many_pictures', 409);
    expect(await countOf(db, prefix, 'tickets')).toBe(0);
    const opened = ok(await tickets.open(PERSON, { category: 'bug', subject: 'One', body: 'x', pictureIds: [two[0]!], consent: CONSENT }));
    refusedAs(await tickets.write(PERSON, opened.id, { body: 'a second', pictureIds: [two[1]!] }), 'too_many_pictures', 409);
    expect(await countOf(db, prefix, 'attachments', 'ticket_id = ?', [opened.id])).toBe(1);
    await ops.stop();
  });

  it('an actor is a person by its plan word or a staff member by its role word, never both: an object carrying both is refused, so a person record with a role is never read as staff', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const tickets = ops.tickets!;
    const webp = await smallWebp();
    const own = ok(await tickets.upload(PERSON, webp, 'image/webp'));
    const enriched = { ...PERSON, role: 'member' } as unknown as typeof PERSON;
    refusedAs(await tickets.upload(enriched, webp, 'image/webp'), 'refused', 400);
    refusedAs(await tickets.picture(enriched, own.id), 'not_found', 404);
    const staffWithPlan = { ...STAFF, plan: 'free' } as unknown as typeof STAFF;
    refusedAs(await tickets.upload(staffWithPlan, webp, 'image/webp'), 'refused', 400);
    refusedAs(await tickets.picture(staffWithPlan, own.id), 'not_found', 404);
    expect(await countOf(db, prefix, 'attachments')).toBe(1);
    ok(await tickets.picture(PERSON, own.id));
    ok(await tickets.picture(STAFF, own.id));
    await ops.stop();
  });

  it('a decoder that cannot be loaded is a fault the upload throws, never answered as not_an_image, and nothing is written', async () => {
    const decode: PictureDecoder = async () => {
      throw new PictureDecoderUnavailable(new Error('sharp is not installed'));
    };
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const tickets = createTickets(createContext(fixture.options), { decode });
    const webp = await smallWebp();
    await expect(tickets.upload(PERSON, webp, 'image/webp')).rejects.toBeInstanceOf(PictureDecoderUnavailable);
    expect(await countOf(db, prefix, 'attachments')).toBe(0);
    tickets.closeAll();
  });
});
