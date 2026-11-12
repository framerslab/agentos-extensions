/**
 * @fileoverview The note bundle: a versioned ZIP of a person's notes for export and import, one Markdown file a note in
 * folders that mirror the person's folders, and `notes.json`, the manifest that carries identity (each note's stable
 * id, folder, pin, sources, tags, compatibility fields and known times) and the part accounting. Past
 * `NOTE_BUNDLE_LIMITS`, one frozen snapshot comes as numbered parts, each importable alone; a note whose own file passes
 * the byte bound goes alone in a part, so no note is split or left out. The writer writes entry by entry through
 * `writeArchive` with its progress and its stop; the reader opens the ZIP one entry at a time through `openArchive`,
 * under a bound on the bytes it inflates, and refuses a newer version whole. Browser-safe.
 *
 * @module document-export/transcript/notes
 */

import { ArchiveError, REFUSED } from '../archive/errors.js';
import { openArchive, type ArchiveListing } from '../archive/openArchive.js';
import { writeArchive, type ArchiveEntry } from './archive.js';

/** The format's name in every manifest. */
export const NOTE_BUNDLE_FORMAT = 'note-bundle';
/** The format's version this build writes and the newest it reads. */
export const NOTE_BUNDLE_VERSION = 1;
/** One part's bounds: at most 2,000 notes and 10 MiB of note bytes (a note's file and its manifest entry). */
export const NOTE_BUNDLE_LIMITS = { notes: 2000, bytes: 10_485_760 } as const;
/**
 * The most bytes one note may count, its file and its manifest entry: 32 MiB, so a part of one such note and its
 * manifest reads back under the reader's default bound of 64 MiB.
 */
export const NOTE_BUNDLE_MAX_NOTE_BYTES = 33_554_432;
/** The bound a read keeps when the caller names none, the manifest and the notes' files together: 64 MiB. */
export const NOTE_BUNDLE_READ_BYTES = 67_108_864;

/** A folder as the bundle keeps it: its id, its name (null when the copy could not open it) and its parent's id. */
export interface BundleFolder {
  id: string;
  name: string | null;
  parentId: string | null;
}

/** A structured source as the note keeps it: the kind and the reference a derived id reads (null when it has none). */
export interface BundleSource {
  kind: string;
  ref: string | null;
}

/** One note: its stable id, its block as the device keeps it, and the details the manifest carries. */
export interface BundleNote {
  /** The note's stable id, which an import matches by. */
  id: string;
  /** The note's block as its copy keeps it, written as its file byte for byte. */
  block: string;
  /** The note's title, which names its file. */
  title: string;
  /** The folder the note is filed in, or null at the top. */
  folderId: string | null;
  /** True for a pinned note. */
  pinned: boolean;
  /** Where the note came from. */
  sources: BundleSource[];
  /** The note's tags, as its copy keeps them. */
  tags: string[];
  /** The fields an older reader of the notes keeps: the title's slug and the content's version, null when unknown. */
  compat: { slug: string | null; contentVersion: number | null };
  /** When the note was made, an ISO 8601 time, or null when unknown. */
  createdAt: string | null;
  /** When the note last changed, an ISO 8601 time, or null when unknown. */
  changedAt: string | null;
}

/** A frozen snapshot of one copy, the account's or a browser's. */
export interface BundleSnapshot {
  /** The snapshot's id, the same in every part made from it. */
  id: string;
  /** When the snapshot was taken, an ISO 8601 time. */
  at: string;
  /** Which copy it was taken from. */
  copy: 'account' | 'browser';
  /** Every folder of the copy. */
  folders: readonly BundleFolder[];
  /** Every note of the copy, in the order its files are written. */
  notes: readonly BundleNote[];
}

/** One part of a snapshot: its index from 0, the note ids it holds and its bytes. */
export interface BundlePartPlan {
  index: number;
  noteIds: string[];
  bytes: number;
}

/** A note's entry in the manifest: every detail but its block, and its file's path in the archive. */
export type BundleManifestNote = Omit<BundleNote, 'block'> & { path: string };

/** The manifest one part carries. */
export interface BundleManifest {
  format: typeof NOTE_BUNDLE_FORMAT;
  version: number;
  snapshot: { id: string; at: string; copy: 'account' | 'browser' };
  /** This part, its index from 1, of `count`. */
  part: { index: number; count: number };
  /** Every part of the snapshot, its index from 1, with its note ids and bytes. */
  parts: { index: number; noteIds: string[]; bytes: number }[];
  folders: BundleFolder[];
  notes: BundleManifestNote[];
}

/** Why a bundle could not be read. */
export type NoteBundleReason = 'not_a_bundle' | 'newer_version' | 'bad_manifest';

/** A bundle refused, with its reason. The message is fixed for each reason and carries nothing read from the file. */
export class NoteBundleError extends Error {
  /** @param reason Why the bundle was refused. */
  constructor(readonly reason: NoteBundleReason) {
    super(`note bundle: ${reason}`);
    this.name = 'NoteBundleError';
  }
}

/** The manifest's path, at the archive's top. */
export const NOTE_BUNDLE_MANIFEST = 'notes.json';

const encoder = new TextEncoder();

/** The characters a file system refuses in a name, or reads as a separator, a drive or a wildcard. */
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/** A name Windows keeps for a device, with or without an extension (`CON`, `nul.txt`, `LPT1`). */
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])\s*(\..*)?$/i;

/** The most characters a name keeps. */
const NAME_CHARACTERS = 120;
/** The most UTF-8 bytes a name keeps, so a numbered suffix and `.md` stay within a file system's 255 a name. */
const NAME_BYTES = 200;

/**
 * A title made safe for a file system: no separators, controls or reserved marks; at most 120 characters and 200 bytes
 * of UTF-8, cut between two characters; no trailing dots or spaces, which Windows drops; `Untitled` when nothing is left;
 * and a name Windows keeps for a device marked with a leading `_`.
 */
function safeName(title: string): string {
  let cleaned = '';
  let characters = 0;
  let bytes = 0;
  for (const character of title.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim()) {
    const size = encoder.encode(character).length;
    if (characters === NAME_CHARACTERS || bytes + size > NAME_BYTES) break;
    cleaned += character;
    characters += 1;
    bytes += size;
  }
  cleaned = cleaned.replace(/[. ]+$/, '');
  if (cleaned === '') return 'Untitled';
  return DEVICE.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Each folder's path from the top, a folder with no name named by its id's first eight characters, and a folder at the
 * top named for the manifest renamed `notes.json (2)`. A chain that meets a folder twice (a damaged copy) stops there,
 * so every path is finite.
 */
function folderPaths(folders: readonly BundleFolder[]): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  const walking = new Set<string>();
  const pathOf = (id: string): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const folder = byId.get(id);
    if (folder === undefined || walking.has(id)) return '';
    walking.add(id);
    const own = folder.name === null ? safeName(id.slice(0, 8)) : safeName(folder.name);
    const parent = folder.parentId === null ? '' : pathOf(folder.parentId);
    walking.delete(id);
    const path = parent === '' ? (own.toLowerCase() === NOTE_BUNDLE_MANIFEST ? `${own} (2)` : own) : `${parent}/${own}`;
    paths.set(id, path);
    return path;
  };
  for (const folder of folders) pathOf(folder.id);
  return paths;
}

/**
 * Every note's path in the archive, keyed by the note's id: its folder's path, then its title made safe with `.md`,
 * unique within the archive whatever its case by a numbered suffix (`Plan (2).md`), in the snapshot's order. Every
 * folder's path and `notes.json` at the top are taken before the first note is named, so no note's file shares a path
 * with a folder or the manifest.
 *
 * @throws {RangeError} When two notes share one id.
 */
export function noteFileNames(snapshot: Pick<BundleSnapshot, 'folders' | 'notes'>): Map<string, string> {
  const ids = new Set<string>();
  for (const note of snapshot.notes) {
    if (ids.has(note.id)) throw new RangeError('note bundle: two notes share one id');
    ids.add(note.id);
  }
  const folders = folderPaths(snapshot.folders);
  const taken = new Set<string>([NOTE_BUNDLE_MANIFEST]);
  for (const path of folders.values()) taken.add(path.toLowerCase());
  const names = new Map<string, string>();
  for (const note of snapshot.notes) {
    const folder = note.folderId === null ? '' : (folders.get(note.folderId) ?? '');
    const base = safeName(note.title);
    let n = 1;
    let path = '';
    do {
      const file = n === 1 ? `${base}.md` : `${base} (${n}).md`;
      path = folder === '' ? file : `${folder}/${file}`;
      n += 1;
    } while (taken.has(path.toLowerCase()));
    taken.add(path.toLowerCase());
    names.set(note.id, path);
  }
  return names;
}

/** A note's manifest entry as the writer writes it: every detail but its block, then its path. */
function manifestEntry(note: BundleNote, path: string): BundleManifestNote {
  const { block: _block, ...entry } = note;
  return { ...entry, path };
}

/** The indent of a note's entry in `notes.json`, which the writer writes with two spaces a level. */
const ENTRY_INDENT = '    ';
/** The bytes around an entry in `notes.json`: its first line's indent, and the comma and line break after it. */
const ENTRY_FRAME = ENTRY_INDENT.length + 2;

/**
 * A note's bytes in a part: its file, and its manifest entry as `notes.json` holds it, its path among its fields,
 * indented as the writer indents it, with the comma and line break after it.
 */
function noteBytes(note: BundleNote, path: string): number {
  const written = JSON.stringify(manifestEntry(note, path), null, 2).replace(/\n/g, `\n${ENTRY_INDENT}`);
  return encoder.encode(note.block).length + encoder.encode(written).length + ENTRY_FRAME;
}

/** What a plan is bounded by: one part's notes and bytes, and the bytes a read of one part keeps (`NOTE_BUNDLE_READ_BYTES` unless named). */
export interface NoteBundleLimits {
  notes: number;
  bytes: number;
  readBytes?: number;
}

/** Room for the snapshot's id and time, which the plan does not hold, in a manifest's count. */
const SNAPSHOT_ROOM = 256;

/**
 * The bytes of a part's `notes.json` before its notes' entries: the format, the version, the snapshot and the part, the
 * index of every part and the snapshot's folders, formatted as the writer formats them, with room for the snapshot's
 * id and time.
 */
function manifestBytes(folders: readonly BundleFolder[], parts: readonly BundlePartPlan[]): number {
  const skeleton: BundleManifest = {
    format: NOTE_BUNDLE_FORMAT,
    version: NOTE_BUNDLE_VERSION,
    snapshot: { id: '', at: '', copy: 'browser' },
    part: { index: parts.length, count: parts.length },
    parts: parts.map((each, i) => ({ index: i + 1, noteIds: each.noteIds, bytes: each.bytes })),
    folders: folders.map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId })),
    notes: [],
  };
  return encoder.encode(JSON.stringify(skeleton, null, 2)).length + SNAPSHOT_ROOM;
}

/**
 * The snapshot's parts: notes in the snapshot's order, a part closed before a note would pass either bound, and a note
 * whose own bytes pass the byte bound alone in a part of its own. A note counts as its file and its manifest entry as
 * written, its path among the entry's fields. Every part, with its manifest's index of the parts and the snapshot's
 * folders, stays within the bytes a read keeps, so each part the plan makes reads back under the reader's bound. An
 * empty snapshot is one empty part.
 *
 * @throws {RangeError} When two notes share one id, a note counts more than `NOTE_BUNDLE_MAX_NOTE_BYTES`, or a part
 * with its manifest would pass `limits.readBytes`.
 */
export function planNoteBundle(snapshot: Pick<BundleSnapshot, 'folders' | 'notes'>, limits: NoteBundleLimits = NOTE_BUNDLE_LIMITS): BundlePartPlan[] {
  const names = noteFileNames(snapshot);
  const parts: BundlePartPlan[] = [];
  let open: BundlePartPlan = { index: 0, noteIds: [], bytes: 0 };
  for (const note of snapshot.notes) {
    const bytes = noteBytes(note, names.get(note.id) as string);
    if (bytes > NOTE_BUNDLE_MAX_NOTE_BYTES) throw new RangeError(`note bundle: a note of ${bytes} bytes passes the ${NOTE_BUNDLE_MAX_NOTE_BYTES} one note may count`);
    const full = open.noteIds.length >= limits.notes || (open.noteIds.length > 0 && open.bytes + bytes > limits.bytes);
    if (full) {
      parts.push(open);
      open = { index: parts.length, noteIds: [], bytes: 0 };
    }
    open.noteIds.push(note.id);
    open.bytes += bytes;
  }
  if (open.noteIds.length > 0 || parts.length === 0) parts.push(open);
  const readBytes = limits.readBytes ?? NOTE_BUNDLE_READ_BYTES;
  const manifest = manifestBytes(snapshot.folders, parts);
  for (const part of parts) {
    if (part.bytes + manifest > readBytes) throw new RangeError(`note bundle: a part of ${part.bytes + manifest} bytes with its manifest passes the ${readBytes} a read keeps`);
  }
  return parts;
}

/** The options a part's write takes: the archive writer's progress and stop, and the version (tests write a newer one). */
export interface WritePartOptions {
  /** Called as each note's file has been written, with its place from 1 and the part's count of notes. */
  onNote?: (index: number, count: number) => void;
  /** Stops the write between two entries; the promise rejects with `ArchiveError`, reason `stopped`. */
  signal?: AbortSignal;
  /** The version written in the manifest; this build's when absent. */
  version?: number;
}

/**
 * One part as a ZIP: its notes' Markdown files, then `notes.json`. The write goes entry by entry, and a stop rejects
 * with the archive writer's `ArchiveError` (reason `stopped`), handing back no archive. The parts are numbered from 1 in
 * the plan's order, and the part's entry lists the notes its files hold.
 *
 * @throws {RangeError} When the plan holds no part of that index, or two notes share one id.
 */
export async function writeNoteBundlePart(snapshot: BundleSnapshot, plan: readonly BundlePartPlan[], index: number, options: WritePartOptions = {}): Promise<Uint8Array> {
  const part = plan[index];
  if (part === undefined) throw new RangeError(`note bundle: no part ${index} of ${plan.length}`);
  const names = noteFileNames(snapshot);
  const wanted = new Set(part.noteIds);
  const notes = snapshot.notes.filter((note) => wanted.has(note.id));
  const manifest: BundleManifest = {
    format: NOTE_BUNDLE_FORMAT,
    version: options.version ?? NOTE_BUNDLE_VERSION,
    snapshot: { id: snapshot.id, at: snapshot.at, copy: snapshot.copy },
    part: { index: index + 1, count: plan.length },
    parts: plan.map((each, i) => ({ index: i + 1, noteIds: i === index ? notes.map((note) => note.id) : [...each.noteIds], bytes: each.bytes })),
    folders: snapshot.folders.map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId })),
    notes: notes.map((note) => manifestEntry(note, names.get(note.id) as string)),
  };
  const entries: ArchiveEntry[] = [...notes.map((note) => ({ path: names.get(note.id) as string, data: note.block })), { path: NOTE_BUNDLE_MANIFEST, data: JSON.stringify(manifest, null, 2) }];
  return writeArchive(entries, {
    onEntry: (i) => {
      if (i < notes.length) options.onNote?.(i + 1, notes.length);
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** A read bundle part: its manifest, its notes with their blocks, its folders and every file path it held. */
export interface ReadBundle {
  manifest: BundleManifest;
  notes: BundleNote[];
  folders: BundleFolder[];
  paths: string[];
}

/** What a read is bounded by, and how it inflates. */
export interface ReadNoteBundleOptions {
  /** The most bytes the manifest and the notes' files may hold together, read from the directory before any. Default 64 MiB. */
  maxInflatedBytes?: number;
  /** Inflate in fflate's worker (the default) or, with `false`, on the calling thread. */
  worker?: boolean;
  /** Stops the read; it rejects with the archive reader's `ArchiveError`, reason `stopped`. */
  signal?: AbortSignal;
}

/** The bound a read keeps when the caller names none, which every part a plan makes stays within. */
const MAX_INFLATED_BYTES = NOTE_BUNDLE_READ_BYTES;

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A folder of the manifest, or null for a value of another shape. */
function folderOf(value: unknown): BundleFolder | null {
  if (!isObject(value) || !isText(value.id) || value.id === '' || !isTextOrNull(value.name) || !isTextOrNull(value.parentId)) return null;
  return { id: value.id, name: value.name, parentId: value.parentId };
}

/** A note's manifest entry, or null for a value of another shape. */
function noteOf(value: unknown): BundleManifestNote | null {
  if (!isObject(value)) return null;
  const { id, path, title, folderId, pinned, sources, tags, compat, createdAt, changedAt } = value;
  if (!isText(id) || id === '' || !isText(path) || path === NOTE_BUNDLE_MANIFEST || !isText(title) || !isTextOrNull(folderId) || typeof pinned !== 'boolean') return null;
  if (!Array.isArray(sources) || !Array.isArray(tags) || !tags.every(isText) || !isObject(compat)) return null;
  if (!isTextOrNull(createdAt) || !isTextOrNull(changedAt)) return null;
  const read = sources.map((source) => (isObject(source) && isText(source.kind) && isTextOrNull(source.ref) ? { kind: source.kind, ref: source.ref } : null));
  if (read.some((source) => source === null)) return null;
  const { slug, contentVersion } = compat;
  if (!isTextOrNull(slug) || !(contentVersion === null || (typeof contentVersion === 'number' && Number.isFinite(contentVersion)))) return null;
  return { id, path, title, folderId, pinned, sources: read as BundleSource[], tags: [...tags], compat: { slug, contentVersion }, createdAt, changedAt };
}

/** A part's index entry, or null for a value of another shape. */
function partOf(value: unknown): BundleManifest['parts'][number] | null {
  if (!isObject(value) || !isCount(value.index) || !isCount(value.bytes) || !Array.isArray(value.noteIds) || !value.noteIds.every(isText)) return null;
  return { index: value.index, noteIds: [...value.noteIds], bytes: value.bytes };
}

/**
 * The manifest a parsed `notes.json` holds. Another format is `not_a_bundle`; a version above this build's is
 * `newer_version`, before any other field is read; a field of the wrong shape, two notes of one id or one path, a note
 * whose path is the manifest's, a part list that does not hold `count` parts numbered from 1, or this part's entry
 * listing other notes than the manifest's, is `bad_manifest`.
 */
function manifestOf(value: unknown): BundleManifest {
  if (!isObject(value) || value.format !== NOTE_BUNDLE_FORMAT) throw new NoteBundleError('not_a_bundle');
  const { version, snapshot, part, parts, folders, notes } = value;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new NoteBundleError('bad_manifest');
  if (version > NOTE_BUNDLE_VERSION) throw new NoteBundleError('newer_version');
  if (!isObject(snapshot) || !isObject(part)) throw new NoteBundleError('bad_manifest');
  const { id, at, copy } = snapshot;
  const { index, count } = part;
  if (!isText(id) || !isText(at) || (copy !== 'account' && copy !== 'browser')) throw new NoteBundleError('bad_manifest');
  if (!isCount(index) || !isCount(count) || index < 1 || index > count) throw new NoteBundleError('bad_manifest');
  if (!Array.isArray(parts) || !Array.isArray(folders) || !Array.isArray(notes)) throw new NoteBundleError('bad_manifest');
  const readParts = parts.map(partOf);
  const readFolders = folders.map(folderOf);
  const readNotes = notes.map(noteOf);
  if (readParts.some((each) => each === null) || readFolders.some((each) => each === null) || readNotes.some((each) => each === null)) throw new NoteBundleError('bad_manifest');
  const kept = readNotes as BundleManifestNote[];
  if (new Set(kept.map((note) => note.id)).size !== kept.length || new Set(kept.map((note) => note.path)).size !== kept.length) throw new NoteBundleError('bad_manifest');
  const listed = readParts as BundleManifest['parts'];
  if (listed.length !== count || listed.some((each, i) => each.index !== i + 1)) throw new NoteBundleError('bad_manifest');
  const ownIds = (listed[index - 1] as BundleManifest['parts'][number]).noteIds;
  const own = new Set(ownIds);
  if (ownIds.length !== kept.length || own.size !== ownIds.length || kept.some((note) => !own.has(note.id))) throw new NoteBundleError('bad_manifest');
  return {
    format: NOTE_BUNDLE_FORMAT,
    version,
    snapshot: { id, at, copy },
    part: { index, count },
    parts: listed,
    folders: readFolders as BundleFolder[],
    notes: kept,
  };
}

/**
 * One part read back, entry by entry through `openArchive`. A ZIP with no `notes.json` at its top, or one of another
 * format, is `not_a_bundle` (the caller reads it as files); a manifest of a newer version is `newer_version`, refused
 * whole with no note read; a manifest of the wrong shape, a manifest or note file the ZIP records twice, a note that
 * names a file the ZIP does not hold, or a note file that is not UTF-8, is `bad_manifest`. A block keeps a leading byte
 * order mark. The manifest and the notes' files may inflate to `maxInflatedBytes` together, counted from the sizes
 * the directory records before any is read, and each read is checked against its recorded length; a note of any size
 * within that bound reads back whole.
 *
 * @throws {NoteBundleError} For a file that is not a bundle this build reads, as above.
 * @throws {ArchiveError} When the bytes are not a ZIP the archive reader opens, an entry it needs is refused, the
 * files pass the bound (reason `size`), or the signal fires (reason `stopped`).
 */
export async function readNoteBundle(bytes: Uint8Array | Blob, options: ReadNoteBundleOptions = {}): Promise<ReadBundle> {
  const limit = options.maxInflatedBytes ?? MAX_INFLATED_BYTES;
  if (!(limit >= 0)) throw new RangeError(`note bundle: maxInflatedBytes must be zero or more, not ${limit}.`);
  const blob = bytes instanceof Uint8Array ? new Blob([Uint8Array.from(bytes).buffer]) : bytes;
  const archive = await openArchive(blob, options.signal === undefined ? {} : { signal: options.signal });
  try {
    const files = archive.entries.filter((entry) => entry.kind === 'file');
    const byPath = new Map<string, ArchiveListing>();
    // A path the ZIP records twice leaves its text in doubt, so the manifest and the notes never read one.
    const twice = new Set<string>();
    for (const entry of files) {
      if (entry.unsafe) continue;
      if (byPath.has(entry.path)) twice.add(entry.path);
      else byPath.set(entry.path, entry);
    }
    const listed = byPath.get(NOTE_BUNDLE_MANIFEST);
    if (listed === undefined) throw new NoteBundleError('not_a_bundle');
    if (twice.has(NOTE_BUNDLE_MANIFEST)) throw new NoteBundleError('bad_manifest');
    const read = (entry: ArchiveListing, budget: number): Promise<Uint8Array> =>
      entry.bytes({ maxBytes: budget, ...(options.worker === undefined ? {} : { worker: options.worker }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
    const raw = await read(listed, limit);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new NoteBundleError('bad_manifest');
    }
    const manifest = manifestOf(parsed);
    const entries = manifest.notes.map((note) => {
      const entry = byPath.get(note.path);
      if (entry === undefined || twice.has(note.path)) throw new NoteBundleError('bad_manifest');
      return entry;
    });
    // Every file's recorded size counts against the bound before the first is inflated.
    let left = limit - raw.length;
    for (const entry of entries) left -= entry.size;
    if (left < 0) throw new ArchiveError('size', REFUSED.size);
    // A block reads back as it was written: a leading byte order mark is the block's own character, and bytes that are
    // not UTF-8 are refused rather than read as replacement characters.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const notes: BundleNote[] = [];
    for (const [i, { path: _path, ...entry }] of manifest.notes.entries()) {
      const file = entries[i] as ArchiveListing;
      const data = await read(file, file.size);
      let block: string;
      try {
        block = decoder.decode(data);
      } catch {
        throw new NoteBundleError('bad_manifest');
      }
      notes.push({ ...entry, block });
    }
    return { manifest, notes, folders: manifest.folders, paths: files.map((entry) => entry.path) };
  } finally {
    archive.close();
  }
}
