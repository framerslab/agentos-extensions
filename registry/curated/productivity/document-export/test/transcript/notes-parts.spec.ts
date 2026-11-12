/**
 * The note bundle's parts: past 2,000 notes or 10 MiB of note bytes, one frozen snapshot comes as numbered parts, each
 * carrying the index of every part and importable alone; a note whose own file passes the byte bound goes alone in a
 * part of its own and reads back whole, so no note is split or left out.
 */
import { describe, expect, it } from 'vitest';

import { NOTE_BUNDLE_LIMITS, planNoteBundle, readNoteBundle, writeNoteBundlePart, type BundleNote, type BundleSnapshot } from '../../src/transcript/notes.js';

/** A note of the given text, with the id its number makes. */
function note(n: number, text: string): BundleNote {
  const id = n.toString(16).padStart(32, '0');
  return { id, block: `## Note ${n}\n# note-id: ${id}\n${text}`, title: `Note ${n}`, folderId: null, pinned: false, sources: [], tags: [], compat: { slug: null, contentVersion: null }, createdAt: null, changedAt: null };
}

/** A browser's snapshot of the notes given. */
function snapshot(notes: BundleNote[]): BundleSnapshot {
  return { id: 'd'.repeat(32), at: '2026-11-10T09:00:00.000Z', copy: 'browser', folders: [], notes };
}

describe('the note bundle in parts', () => {
  it('plans 2,001 notes as two parts of 2,000 and 1', () => {
    const notes = Array.from({ length: 2001 }, (_, i) => note(i + 1, 'x'));
    const plan = planNoteBundle(snapshot(notes));
    expect(plan.map((part) => part.noteIds.length)).toEqual([2000, 1]);
    expect(plan.map((part) => part.index)).toEqual([0, 1]);
    expect(NOTE_BUNDLE_LIMITS).toEqual({ notes: 2000, bytes: 10_485_760 });
  });

  it('plans notes of 6,000,000 bytes one a part, since two pass the byte bound', () => {
    const notes = [1, 2, 3].map((n) => note(n, 'y'.repeat(6_000_000)));
    expect(planNoteBundle(snapshot(notes)).map((part) => part.noteIds)).toEqual(notes.map((each) => [each.id]));
  });

  it('puts a note of 11,000,000 bytes alone in a part past the byte bound, and reads it back whole', async () => {
    const small = note(1, 'small');
    const large = note(2, 'z'.repeat(11_000_000));
    const after = note(3, 'after');
    const whole = snapshot([small, large, after]);
    const plan = planNoteBundle(whole);
    expect(plan.map((part) => part.noteIds)).toEqual([[small.id], [large.id], [after.id]]);
    expect(plan[1]!.bytes).toBeGreaterThan(NOTE_BUNDLE_LIMITS.bytes);
    const read = await readNoteBundle(await writeNoteBundlePart(whole, plan, 1), { worker: false });
    expect(read.notes).toEqual([large]);
    expect(read.manifest.part).toEqual({ index: 2, count: 3 });
  });

  it("carries every part's note ids and bytes in each part's manifest, each part read alone, the parts' notes the snapshot's", async () => {
    const notes = Array.from({ length: 5 }, (_, i) => note(i + 1, 'w'.repeat(40)));
    const whole = snapshot(notes);
    const plan = planNoteBundle(whole, { notes: 2, bytes: NOTE_BUNDLE_LIMITS.bytes });
    expect(plan.map((part) => part.noteIds.length)).toEqual([2, 2, 1]);
    const parts = await Promise.all(plan.map(async (_, i) => readNoteBundle(await writeNoteBundlePart(whole, plan, i), { worker: false })));
    for (const [i, part] of parts.entries()) {
      expect(part.manifest.part).toEqual({ index: i + 1, count: 3 });
      expect(part.manifest.parts).toEqual(plan.map((each) => ({ index: each.index + 1, noteIds: each.noteIds, bytes: each.bytes })));
      expect(part.notes.map((each) => each.id)).toEqual(plan[i]!.noteIds);
    }
    const ids = parts.flatMap((part) => part.notes.map((each) => each.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(parts.flatMap((part) => part.notes)).toEqual(notes);
  });

  it('plans an empty snapshot as one empty part, which reads back with no note', async () => {
    const empty = snapshot([]);
    const plan = planNoteBundle(empty);
    expect(plan).toEqual([{ index: 0, noteIds: [], bytes: 0 }]);
    const read = await readNoteBundle(await writeNoteBundlePart(empty, plan, 0), { worker: false });
    expect(read.notes).toEqual([]);
    expect(read.paths).toEqual(['notes.json']);
  });
});
