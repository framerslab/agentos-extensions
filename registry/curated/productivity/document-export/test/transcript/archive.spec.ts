import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { readArchive, writeArchive } from '../../src/transcript/archive.js';

const MEBIBYTE = 1024 * 1024;

/**
 * Where an archive written by fflate keeps its directory. fflate writes no comment, so the end record is the last
 * 22 bytes, and the directory's start sits 16 bytes into that record (APPNOTE 4.3.16).
 */
function directory(zip: Uint8Array): { view: DataView; start: number; end: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  return { view, start: view.getUint32(end + 16, true), end };
}

/**
 * A copy of the archive whose first file declares another inflated size, as a hostile archive would: the size sits
 * 24 bytes into the file's directory record (APPNOTE 4.3.12).
 */
function declaring(zip: Uint8Array, inflatedSize: number): Uint8Array {
  const copy = zip.slice();
  const { view, start } = directory(copy);
  view.setUint32(start + 24, inflatedSize, true);
  return copy;
}

/** A copy of a one-file archive whose directory lists the file twice, so two entries share one stretch of data. */
function listedTwice(zip: Uint8Array): Uint8Array {
  const { start, end } = directory(zip);
  const record = zip.subarray(start, end);
  const copy = new Uint8Array(zip.length + record.length);
  copy.set(zip.subarray(0, end));
  copy.set(record, end);
  copy.set(zip.subarray(end), end + record.length);
  const view = new DataView(copy.buffer);
  const endRecord = end + record.length;
  view.setUint16(endRecord + 8, 2, true); // the entries on this disk
  view.setUint16(endRecord + 10, 2, true); // the entries in all
  view.setUint32(endRecord + 12, record.length * 2, true); // the directory's size
  return copy;
}

describe('the archive', () => {
  it('writes entries and reads them back, text and bytes', () => {
    const zip = writeArchive([
      { path: 'library.json', data: '{"v":1}' },
      { path: 'sessions/s1.json', data: '{"title":"One"}' },
      { path: 'bytes.bin', data: new Uint8Array([0, 255, 7]) },
    ]);
    const back = readArchive(zip);
    expect(back.map((entry) => entry.path)).toEqual(['library.json', 'sessions/s1.json', 'bytes.bin']);
    expect(new TextDecoder().decode(back[1].data)).toBe('{"title":"One"}');
    expect([...back[2].data]).toEqual([0, 255, 7]);
  });

  it('refuses a path that climbs out or starts at the root', () => {
    expect(() => writeArchive([{ path: '../x', data: '' }])).toThrow('path');
    expect(() => writeArchive([{ path: '/x', data: '' }])).toThrow('path');
  });

  it('refuses to read an archive written elsewhere with a path that climbs out or starts at the root', () => {
    expect(() => readArchive(zipSync({ 'ok.txt': strToU8('ok'), '../x': strToU8('x') }))).toThrow('path');
    expect(() => readArchive(zipSync({ '/x': strToU8('x') }))).toThrow('path');
  });

  it('leaves out a folder entry and reads the files under it', () => {
    // For a nested object fflate writes "sessions/" as an entry of its own, as zip tools do for a folder.
    const zip = zipSync({ sessions: { 's1.json': strToU8('{"title":"One"}') }, 'library.json': strToU8('{"v":1}') });
    expect(readArchive(zip).map((entry) => entry.path)).toEqual(['sessions/s1.json', 'library.json']);
  });

  it('refuses an archive whose files inflate past the bound, their sizes added up', () => {
    const zip = writeArchive([
      { path: 'a.txt', data: 'sixsix' },
      { path: 'b.txt', data: 'fives' },
    ]);
    expect(() => readArchive(zip, { maxInflatedBytes: 10 })).toThrow(RangeError);
    expect(() => readArchive(zip, { maxInflatedBytes: 10 })).toThrow('more than 10 bytes');
    expect(readArchive(zip, { maxInflatedBytes: 11 }).map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
    // A bound that is not a number would compare false against every total and switch the check off.
    expect(() => readArchive(zip, { maxInflatedBytes: Number.NaN })).toThrow('maxInflatedBytes');
  });

  it('counts the size a file declares before it inflates the file, 50 MiB in all unless the caller passes another bound', () => {
    const zip = zipSync({ 'a.txt': strToU8('a'.repeat(1000)) });
    // A small archive that declares one byte past the default is refused before a buffer is made for it.
    const past = declaring(zip, 50 * MEBIBYTE + 1);
    expect(() => readArchive(past)).toThrow(RangeError);
    expect(() => readArchive(past)).toThrow('more than 52428800 bytes');
    expect(readArchive(past, { maxInflatedBytes: 64 * MEBIBYTE })[0].data).toHaveLength(1000);
    // A file yields no more than it declares, so an archive that declares less than it holds cannot pass the bound.
    expect(readArchive(declaring(zip, 10), { maxInflatedBytes: 10 })[0].data).toHaveLength(10);
  });

  it('refuses an archive whose entries share their data, which claim more compressed bytes than it holds', () => {
    const zip = zipSync({ 'a.bin': new Uint8Array(1000) }, { level: 0 });
    expect(readArchive(zip)).toHaveLength(1);
    const shared = listedTwice(zip);
    expect(() => readArchive(shared)).toThrow(RangeError);
    expect(() => readArchive(shared)).toThrow('more compressed bytes than the archive holds');
  });
});
