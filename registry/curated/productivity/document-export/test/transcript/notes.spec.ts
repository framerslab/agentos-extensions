/**
 * The note bundle: a ZIP of one Markdown file a note in folders named for the person's folders, with `notes.json`; the
 * manifest carries identity, so a round trip keeps every id, folder, pin, source, tag, compatibility field and known
 * time; a newer version is refused whole; the write reports each note and stops on its signal with no archive handed
 * back.
 */
import { Zip, ZipPassThrough, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ArchiveError } from '../../src/archive/index.js';
import { writeArchive } from '../../src/transcript/archive.js';
import { NOTE_BUNDLE_VERSION, NoteBundleError, noteFileNames, planNoteBundle, readNoteBundle, writeNoteBundlePart, type BundleSnapshot } from '../../src/transcript/notes.js';

const RESEARCH = 'a'.repeat(32);
const WORK = 'b'.repeat(32);
const SNAPSHOT: BundleSnapshot = {
  id: 'c'.repeat(32),
  at: '2026-11-10T09:00:00.000Z',
  copy: 'browser',
  folders: [
    { id: WORK, name: 'Work', parentId: null },
    { id: RESEARCH, name: 'Research', parentId: WORK },
  ],
  notes: [
    {
      id: '1'.repeat(32),
      block: '## Plan: q4\n# note-id: ' + '1'.repeat(32) + '\n# folder: Work/Research\n# pinned\n# tags: plan, q4\nShip it.',
      title: 'Plan',
      folderId: RESEARCH,
      pinned: true,
      sources: [{ kind: 'drive', ref: 'file-9' }],
      tags: ['plan', 'q4'],
      compat: { slug: 'plan', contentVersion: 3 },
      createdAt: '2026-11-01T08:00:00.000Z',
      changedAt: '2026-11-09T08:00:00.000Z',
    },
    {
      id: '2'.repeat(32),
      block: '## Plan\n# note-id: ' + '2'.repeat(32) + '\nA second plan.',
      title: 'Plan',
      folderId: null,
      pinned: false,
      sources: [],
      tags: [],
      compat: { slug: null, contentVersion: null },
      createdAt: null,
      changedAt: null,
    },
  ],
};

/** A bundle's manifest as JSON text, read from the archive the writer made. */
async function manifestOf(bytes: Uint8Array): Promise<Record<string, unknown>> {
  return (await readNoteBundle(bytes, { worker: false })).manifest as unknown as Record<string, unknown>;
}

describe('the note bundle', () => {
  it('reads back every note with its id, folder chain, pin, sources, tags, compatibility fields and times', async () => {
    const [part] = planNoteBundle(SNAPSHOT);
    const bytes = await writeNoteBundlePart(SNAPSHOT, [part!], 0);
    const read = await readNoteBundle(bytes);
    expect(read.manifest.format).toBe('note-bundle');
    expect(read.manifest.version).toBe(NOTE_BUNDLE_VERSION);
    expect(read.manifest.snapshot).toEqual({ id: SNAPSHOT.id, at: SNAPSHOT.at, copy: 'browser' });
    expect(read.manifest.part).toEqual({ index: 1, count: 1 });
    expect(read.notes).toEqual(SNAPSHOT.notes);
    expect(read.folders).toEqual(SNAPSHOT.folders);
  });

  it('writes one Markdown file a note under its folders, the block byte for byte, the names unique in a folder', async () => {
    const names = noteFileNames(SNAPSHOT);
    expect(names.get('1'.repeat(32))).toBe('Work/Research/Plan.md');
    expect(names.get('2'.repeat(32))).toBe('Plan.md');
    const twins: BundleSnapshot = { ...SNAPSHOT, notes: [SNAPSHOT.notes[1]!, { ...SNAPSHOT.notes[1]!, id: '3'.repeat(32) }] };
    const read = await readNoteBundle(await writeNoteBundlePart(twins, planNoteBundle(twins), 0), { worker: false });
    expect(read.paths.sort()).toEqual(['Plan (2).md', 'Plan.md', 'notes.json']);
    expect(read.notes.map((note) => note.block)).toEqual([twins.notes[0]!.block, twins.notes[1]!.block]);
  });

  it('names a folder the server could not open by its id, and keeps the id with a null name', async () => {
    const snapshot: BundleSnapshot = { ...SNAPSHOT, folders: [{ id: WORK, name: null, parentId: null }, SNAPSHOT.folders[1]!] };
    const names = noteFileNames(snapshot);
    expect(names.get('1'.repeat(32))).toBe('bbbbbbbb/Research/Plan.md');
    const read = await readNoteBundle(await writeNoteBundlePart(snapshot, planNoteBundle(snapshot), 0), { worker: false });
    expect(read.folders[0]).toEqual({ id: WORK, name: null, parentId: null });
  });

  it('makes a title safe for a file system and stops at a folder chain that loops', () => {
    const looped: BundleSnapshot = {
      ...SNAPSHOT,
      folders: [
        { id: WORK, name: 'Work', parentId: RESEARCH },
        { id: RESEARCH, name: 'Re/search', parentId: WORK },
      ],
      notes: [{ ...SNAPSHOT.notes[0]!, title: 'C: a/b\\c*?<>|"\u0007' }, { ...SNAPSHOT.notes[1]!, title: '..' }],
    };
    const names = noteFileNames(looped);
    // Work's chain meets Work again at Research, so Research is named from the top and Work under it.
    expect(names.get('1'.repeat(32))).toBe('Re search/C a b c.md');
    expect(names.get('2'.repeat(32))).toBe('Untitled.md');
  });

  it('refuses a bundle of a newer version whole, reading no note', async () => {
    const bytes = await writeNoteBundlePart(SNAPSHOT, planNoteBundle(SNAPSHOT), 0, { version: NOTE_BUNDLE_VERSION + 1 });
    await expect(readNoteBundle(bytes)).rejects.toEqual(new NoteBundleError('newer_version'));
  });

  it('answers not_a_bundle for a ZIP with no notes.json at its top, and bad_manifest for a note whose file is missing', async () => {
    const plain = writeArchive([{ path: 'notes/a.md', data: '## A\nx' }]);
    await expect(readNoteBundle(plain, { worker: false })).rejects.toEqual(new NoteBundleError('not_a_bundle'));
    const other = zipSync({ 'notes.json': strToU8(JSON.stringify({ format: 'library', version: 1 })) });
    await expect(readNoteBundle(other, { worker: false })).rejects.toEqual(new NoteBundleError('not_a_bundle'));
    const manifest = await manifestOf(await writeNoteBundlePart(SNAPSHOT, planNoteBundle(SNAPSHOT), 0));
    const missing = zipSync({ 'notes.json': strToU8(JSON.stringify(manifest)), 'Plan.md': strToU8('## Plan\nA second plan.') });
    await expect(readNoteBundle(missing, { worker: false })).rejects.toEqual(new NoteBundleError('bad_manifest'));
    const broken = zipSync({ 'notes.json': strToU8('{"format":"note-bundle","version":1,"notes":[{"id":7}]}') });
    await expect(readNoteBundle(broken, { worker: false })).rejects.toEqual(new NoteBundleError('bad_manifest'));
  });

  it('reports each note as it is written, and a stop hands back no archive', async () => {
    const seen: number[] = [];
    const stop = new AbortController();
    const writing = writeNoteBundlePart(SNAPSHOT, planNoteBundle(SNAPSHOT), 0, {
      onNote: (i) => {
        seen.push(i);
        stop.abort();
      },
      signal: stop.signal,
    });
    await expect(writing).rejects.toBeInstanceOf(ArchiveError);
    expect(seen).toEqual([1]);
  });
});

/** A ZIP of the entries in their order, two of one name kept as two records, as a crafted file may hold them. */
function zipOf(entries: [string, Uint8Array][]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        reject(error);
        return;
      }
      chunks.push(chunk);
      if (!final) return;
      const out = new Uint8Array(chunks.reduce((sum, each) => sum + each.length, 0));
      let at = 0;
      for (const each of chunks) {
        out.set(each, at);
        at += each.length;
      }
      resolve(out);
    });
    for (const [name, data] of entries) {
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(data, true);
    }
    zip.end();
  });
}

describe('the note bundle, named for any file system and read strictly', () => {
  it("marks a name Windows keeps for a device, drops a name's trailing dots and spaces, and keeps a name within 200 bytes of UTF-8 with no character split", () => {
    const snapshot: BundleSnapshot = {
      ...SNAPSHOT,
      folders: [
        { id: WORK, name: 'aux', parentId: null },
        { id: RESEARCH, name: 'Notes. ', parentId: WORK },
      ],
      notes: [
        { ...SNAPSHOT.notes[0]!, title: 'CON' },
        { ...SNAPSHOT.notes[1]!, title: 'nul.txt' },
        { ...SNAPSHOT.notes[1]!, id: '3'.repeat(32), title: 'LPT1' },
        { ...SNAPSHOT.notes[1]!, id: '4'.repeat(32), title: '\u{1F600}'.repeat(120) },
      ],
    };
    const names = noteFileNames(snapshot);
    expect(names.get('1'.repeat(32))).toBe('_aux/Notes/_CON.md');
    expect(names.get('2'.repeat(32))).toBe('_nul.txt.md');
    expect(names.get('3'.repeat(32))).toBe('_LPT1.md');
    // Fifty of a four-byte character are 200 bytes; the fifty-first would pass the bound.
    expect(names.get('4'.repeat(32))).toBe(`${'\u{1F600}'.repeat(50)}.md`);
  });

  it('reserves every folder path and the manifest before naming a note, so no file and folder share a path', async () => {
    const snapshot: BundleSnapshot = {
      ...SNAPSHOT,
      folders: [
        { id: WORK, name: 'Plan.md', parentId: null },
        { id: RESEARCH, name: 'notes.json', parentId: null },
      ],
      notes: [
        { ...SNAPSHOT.notes[1]!, title: 'Plan' },
        { ...SNAPSHOT.notes[0]!, title: 'Child', folderId: WORK },
        { ...SNAPSHOT.notes[1]!, id: '3'.repeat(32), title: 'A', folderId: RESEARCH },
      ],
    };
    const names = noteFileNames(snapshot);
    expect(names.get('2'.repeat(32))).toBe('Plan (2).md');
    expect(names.get('1'.repeat(32))).toBe('Plan.md/Child.md');
    expect(names.get('3'.repeat(32))).toBe('notes.json (2)/A.md');
    const read = await readNoteBundle(await writeNoteBundlePart(snapshot, planNoteBundle(snapshot), 0), { worker: false });
    expect(read.notes.map((note) => note.block)).toEqual(snapshot.notes.map((note) => note.block));
  });

  it('refuses two notes of one id before it names, plans or writes them', async () => {
    const twins: BundleSnapshot = { ...SNAPSHOT, notes: [SNAPSHOT.notes[0]!, { ...SNAPSHOT.notes[1]!, id: SNAPSHOT.notes[0]!.id }] };
    expect(() => noteFileNames(twins)).toThrow(RangeError);
    expect(() => planNoteBundle(twins)).toThrow(RangeError);
    await expect(writeNoteBundlePart(twins, [{ index: 0, noteIds: [SNAPSHOT.notes[0]!.id], bytes: 0 }], 0)).rejects.toBeInstanceOf(RangeError);
  });

  it('keeps a block that begins with a byte order mark, character for character', async () => {
    const block = '﻿## Plan\nA second plan.';
    const marked: BundleSnapshot = { ...SNAPSHOT, notes: [{ ...SNAPSHOT.notes[1]!, block }] };
    const read = await readNoteBundle(await writeNoteBundlePart(marked, planNoteBundle(marked), 0), { worker: false });
    expect(read.notes[0]!.block).toBe(block);
  });

  it('refuses as bad_manifest a note named for the manifest, a file held twice, a note file that is not UTF-8, and part accounting that disagrees', async () => {
    const manifest = (await readNoteBundle(await writeNoteBundlePart(SNAPSHOT, planNoteBundle(SNAPSHOT), 0), { worker: false })).manifest;
    const json = (value: unknown): Uint8Array => strToU8(JSON.stringify(value));
    const research = strToU8(SNAPSHOT.notes[0]!.block);
    const plan = strToU8(SNAPSHOT.notes[1]!.block);
    const refused = async (bytes: Uint8Array): Promise<void> => {
      await expect(readNoteBundle(bytes, { worker: false })).rejects.toEqual(new NoteBundleError('bad_manifest'));
    };

    // A note whose path is the manifest's would read the manifest's own JSON as its block.
    const second = manifest.notes[1]!;
    const self = { ...manifest, notes: [{ ...second, path: 'notes.json' }], parts: [{ ...manifest.parts[0]!, noteIds: [second.id] }] };
    await refused(zipSync({ 'notes.json': json(self) }));

    // Two records of one note file, with different texts, leave the note's block in doubt.
    await refused(await zipOf([['notes.json', json(manifest)], ['Work/Research/Plan.md', research], ['Plan.md', plan], ['Plan.md', strToU8('## Plan\nAnother text.')]]));

    // A note file whose bytes are not UTF-8 would come back with replacement characters in place of its text.
    await refused(zipSync({ 'notes.json': json(manifest), 'Work/Research/Plan.md': research, 'Plan.md': new Uint8Array([0xff, 0xfe, 0x41]) }));

    // The part list must hold `count` parts numbered from 1, and this part's entry must list this part's notes.
    const counted = { ...manifest, part: { index: 1, count: 3 } };
    const numbered = { ...manifest, parts: [{ ...manifest.parts[0]!, index: 2 }] };
    const listed = { ...manifest, parts: [{ ...manifest.parts[0]!, noteIds: [manifest.notes[0]!.id] }] };
    for (const each of [counted, numbered, listed]) {
      await refused(zipSync({ 'notes.json': json(each), 'Work/Research/Plan.md': research, 'Plan.md': plan }));
    }
  });
});
