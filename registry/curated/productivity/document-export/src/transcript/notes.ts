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

/** A title made safe for a file system: no separators, controls or reserved marks, at most 120 characters. */
function safeName(title: string): string {
  const cleaned = Array.from(title.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, 120)
    .join('')
    .trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'Untitled' : cleaned;
}

/**
 * Each folder's path from the top, a folder with no name named by its id's first eight characters. A chain that meets
 * a folder twice (a damaged copy) stops there, so every path is finite.
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
    const path = parent === '' ? own : `${parent}/${own}`;
    paths.set(id, path);
    return path;
  };
  for (const folder of folders) pathOf(folder.id);
  return paths;
}

/**
 * Every note's path in the archive, keyed by the note's id: its folder's path, then its title made safe with `.md`,
 * unique within the archive whatever its case by a numbered suffix (`Plan (2).md`), in the snapshot's order. The name
 * `notes.json` at the top is the manifest's, never a note's.
 */
export function noteFileNames(snapshot: Pick<BundleSnapshot, 'folders' | 'notes'>): Map<string, string> {
  const folders = folderPaths(snapshot.folders);
  const taken = new Set<string>([NOTE_BUNDLE_MANIFEST]);
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

/** A note's bytes in a part: its file and its manifest entry. */
function noteBytes(note: BundleNote): number {
  const { block, ...entry } = note;
  return encoder.encode(block).length + encoder.encode(JSON.stringify(entry)).length;
}

/**
 * The snapshot's parts: notes in the snapshot's order, a part closed before a note would pass either bound, and a note
 * whose own bytes pass the byte bound alone in a part of its own. An empty snapshot is one empty part.
 */
export function planNoteBundle(snapshot: Pick<BundleSnapshot, 'notes'>, limits: { notes: number; bytes: number } = NOTE_BUNDLE_LIMITS): BundlePartPlan[] {
  const parts: BundlePartPlan[] = [];
  let open: BundlePartPlan = { index: 0, noteIds: [], bytes: 0 };
  for (const note of snapshot.notes) {
    const bytes = noteBytes(note);
    const full = open.noteIds.length >= limits.notes || (open.noteIds.length > 0 && open.bytes + bytes > limits.bytes);
    if (full) {
      parts.push(open);
      open = { index: parts.length, noteIds: [], bytes: 0 };
    }
    open.noteIds.push(note.id);
    open.bytes += bytes;
  }
  if (open.noteIds.length > 0 || parts.length === 0) parts.push(open);
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
 * with the archive writer's `ArchiveError` (reason `stopped`), handing back no archive.
 *
 * @throws {RangeError} When the plan holds no part of that index.
 */
export async function writeNoteBundlePart(snapshot: BundleSnapshot, plan: readonly BundlePartPlan[], index: number, options: WritePartOptions = {}): Promise<Uint8Array> {
  const part = plan[index];
  if (part === undefined) throw new RangeError(`note bundle: no part ${index} of ${plan.length}`);
  const wanted = new Set(part.noteIds);
  const notes = snapshot.notes.filter((note) => wanted.has(note.id));
  const names = noteFileNames(snapshot);
  const manifest: BundleManifest = {
    format: NOTE_BUNDLE_FORMAT,
    version: options.version ?? NOTE_BUNDLE_VERSION,
    snapshot: { id: snapshot.id, at: snapshot.at, copy: snapshot.copy },
    part: { index: index + 1, count: plan.length },
    parts: plan.map((each) => ({ index: each.index + 1, noteIds: [...each.noteIds], bytes: each.bytes })),
    folders: snapshot.folders.map((folder) => ({ id: folder.id, name: folder.name, parentId: folder.parentId })),
    notes: notes.map(({ block: _block, ...entry }) => ({ ...entry, path: names.get(entry.id) as string })),
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

/** The bound a read keeps when the caller names none: 64 MiB, a part's 10 MiB and one large note beside it. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

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
  if (!isText(id) || id === '' || !isText(path) || !isText(title) || !isTextOrNull(folderId) || typeof pinned !== 'boolean') return null;
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
 * `newer_version`, before any other field is read; a field of the wrong shape, or two notes of one id or one path, is
 * `bad_manifest`.
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
  return {
    format: NOTE_BUNDLE_FORMAT,
    version,
    snapshot: { id, at, copy },
    part: { index, count },
    parts: readParts as BundleManifest['parts'],
    folders: readFolders as BundleFolder[],
    notes: kept,
  };
}

/**
 * One part read back, entry by entry through `openArchive`. A ZIP with no `notes.json` at its top, or one of another
 * format, is `not_a_bundle` (the caller reads it as files); a manifest of a newer version is `newer_version`, refused
 * whole with no note read; a manifest of the wrong shape, or whose note names a file the ZIP does not hold, is
 * `bad_manifest`. The manifest and the notes' files may inflate to `maxInflatedBytes` together, counted from the sizes
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
    for (const entry of files) if (!entry.unsafe && !byPath.has(entry.path)) byPath.set(entry.path, entry);
    const listed = byPath.get(NOTE_BUNDLE_MANIFEST);
    if (listed === undefined) throw new NoteBundleError('not_a_bundle');
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
      if (entry === undefined) throw new NoteBundleError('bad_manifest');
      return entry;
    });
    // Every file's recorded size counts against the bound before the first is inflated.
    let left = limit - raw.length;
    for (const entry of entries) left -= entry.size;
    if (left < 0) throw new ArchiveError('size', REFUSED.size);
    const decoder = new TextDecoder();
    const notes: BundleNote[] = [];
    for (const [i, { path: _path, ...entry }] of manifest.notes.entries()) {
      const file = entries[i] as ArchiveListing;
      notes.push({ ...entry, block: decoder.decode(await read(file, file.size)) });
    }
    return { manifest, notes, folders: manifest.folders, paths: files.map((entry) => entry.path) };
  } finally {
    archive.close();
  }
}
