import { zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError, openArchive } from '../../src/archive/index.js';
import { UnreadableBlob, blobOf } from './fixtures.js';

describe("an archive's end record", () => {
  it('opens an archive of exactly 65,535 entries that records its count without ZIP64, as fflate writes it', async () => {
    const files: Zippable = {};
    for (let i = 0; i < 65_535; i++) files[`n${i}`] = new Uint8Array(0);
    const zip = zipSync(files, { level: 0 });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const end = zip.length - 22;
    // The count fits its 16 bits, so the end record holds 0xFFFF as it is and no ZIP64 locator precedes it
    // (APPNOTE 4.4.1.4 asks for ZIP64 only when a field is too small for its value; 4.3.15 places the locator).
    expect(view.getUint16(end + 8, true)).toBe(0xffff);
    expect(view.getUint16(end + 10, true)).toBe(0xffff);
    expect(view.getUint32(end - 20, true)).not.toBe(0x07064b50);

    const opened = await openArchive(blobOf(zip));
    expect(opened.entries).toHaveLength(65_535);
    const last = opened.entries[65_534]!;
    expect(last.path).toBe('n65534');
    expect(await last.bytes({ worker: false })).toEqual(new Uint8Array(0));
    opened.close();
  });

  it('refuses an archive whose Blob cannot hand back its bytes, with a fixed message', async () => {
    const zip = zipSync({ 'a.txt': new Uint8Array(1) });
    const error = await openArchive(new UnreadableBlob([Uint8Array.from(zip).buffer], () => true)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).reason).toBe('format');
    expect((error as ArchiveError).message).not.toContain('poison');
  });
});
