// @ts-nocheck
/**
 * @fileoverview Where `text_to_speech` keeps the audio it makes.
 *
 * The audio a provider answers with used to go back to the model as base64
 * in the tool's output: a 30-second MP3 is 240 KB in the next request. The
 * tool saves the bytes to a file and returns its `file:` URL, or hands them
 * to the host's own saver, which returns an http(s) URL.
 *
 * The directory follows the image packs' `imageFiles.ts`. It is private to
 * the service's user, and each caller has a subdirectory of its own, taken
 * by the directory's real path and never through a link. Every directory
 * above it must belong to this user or root and be writable by no one else
 * unless it is sticky, as /tmp is: a user who could rename an entry there
 * could swap the tree between the checks and the write and so receive
 * another caller's speech, and Node has no openat to pin a checked
 * directory. On Windows, where Node reads no ACLs, only the directories'
 * kind is checked and the caller's directory must not be a link (a junction
 * is one); the default there is in the user's own profile.
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The audio directory: the pack option `audioDir`, else the environment
 * variable `AGENTOS_AUDIO_DIR`, else a folder in the user's temp directory,
 * which the operating system clears (the pack deletes nothing). On POSIX the
 * default carries the user id, since `/tmp` is shared. On Windows it is the
 * user's own temp folder whatever `TEMP` says: `os.tmpdir()` reads `TEMP`,
 * which can name a folder every user shares.
 */
export function audioDirectory(option?: unknown): string {
  const named = [option, process.env.AGENTOS_AUDIO_DIR]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  if (named) return path.resolve(named);
  if (typeof process.getuid === 'function') return path.join(os.tmpdir(), `agentos-audio-${process.getuid()}`);
  return path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'agentos-audio');
}

/**
 * The name of a caller's subdirectory: `u-` and 32 hex characters of the
 * SHA-256 of its user id, or `shared` for a call that carries none.
 */
export function scopeOf(context?: { userContext?: { userId?: unknown } }): string {
  const userId = context?.userContext?.userId;
  return typeof userId === 'string' && userId !== ''
    ? `u-${createHash('sha256').update(userId).digest('hex').slice(0, 32)}`
    : 'shared';
}

/**
 * Whether a directory's `stat` (taken with `bigint: true`) shows it private
 * to this user: a directory this user owns that neither its group nor others
 * can write. Where the platform has no user ids (Windows) only the kind is
 * checked.
 */
function isPrivateDirectory(stat: { isDirectory(): boolean; uid: bigint; mode: bigint }): boolean {
  if (!stat.isDirectory()) return false;
  if (typeof process.getuid !== 'function') return true;
  return stat.uid === BigInt(process.getuid()) && (stat.mode & BigInt(0o022)) === BigInt(0);
}

/** The error for a directory that is not private to this user. */
function notPrivate(dir: string, stat?: { isDirectory(): boolean; uid: bigint; mode: bigint }): Error {
  if (stat && typeof process.getuid === 'function') {
    const mode = (stat.mode & BigInt(0o7777)).toString(8).padStart(4, '0');
    return new Error(
      `${dir} is not a directory that this user owns and no one else can write (owner uid ${stat.uid}, mode ${mode}${stat.isDirectory() ? '' : ', not a directory'})`,
    );
  }
  return new Error(`${dir} is not a directory (a link to one is refused)`);
}

/**
 * Why another user could change a directory above `dir`, a real path, or
 * `undefined` when none can: each directory above it must belong to this
 * user or root and be writable by no one else, unless it is sticky, where
 * only an entry's owner can rename it. Where the platform has no user ids
 * (Windows) nothing is checked.
 */
async function changeableParent(dir: string): Promise<string | undefined> {
  if (typeof process.getuid !== 'function') return undefined;
  const uid = BigInt(process.getuid());
  for (let parent = path.dirname(dir); ; parent = path.dirname(parent)) {
    const stat = await fs.lstat(parent, { bigint: true });
    const mode = (stat.mode & BigInt(0o7777)).toString(8).padStart(4, '0');
    if (!stat.isDirectory()) return `${parent}, above it, is not a directory`;
    if (stat.uid !== uid && stat.uid !== BigInt(0)) return `${parent}, above it, belongs to uid ${stat.uid} (mode ${mode})`;
    if ((stat.mode & BigInt(0o022)) !== BigInt(0) && (stat.mode & BigInt(0o1000)) === BigInt(0)) {
      return `${parent}, above it, can be written by others and is not sticky (owner uid ${stat.uid}, mode ${mode})`;
    }
    if (path.dirname(parent) === parent) return undefined;
  }
}

/**
 * The caller's subdirectory of `dir`, by `dir`'s real path, with both made
 * when missing, for this user alone.
 *
 * @throws When either cannot be made or written, is not a directory this user
 *   owns that no one else can write, or has a directory above it that another
 *   user can change; the caller's directory must not be a link.
 */
async function callerDirectory(dir: string, scope: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Written by the real path, so a link swapped in for it later moves nothing.
  const root = await fs.realpath(dir);
  const rootStat = await fs.stat(root, { bigint: true });
  if (!isPrivateDirectory(rootStat)) throw notPrivate(root, rootStat);
  const parent = await changeableParent(root);
  if (parent) throw new Error(parent);
  const scopeDir = path.join(root, scope);
  await fs.mkdir(scopeDir, { recursive: true, mode: 0o700 });
  // lstat: a caller's directory that is a link to another caller's is refused.
  const scopeStat = await fs.lstat(scopeDir, { bigint: true });
  if (!isPrivateDirectory(scopeStat)) throw notPrivate(scopeDir, scopeStat);
  // A directory this user owns can still refuse a new file: its mode (0500),
  // or a file system mounted read-only.
  await fs.access(scopeDir, fsConstants.W_OK | fsConstants.X_OK);
  return scopeDir;
}

/** The error of a save that cannot use `dir`: it names the directory and the options that change it. */
function cannotSave(dir: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `The audio could not be saved under ${dir}: ${reason}. Set the pack's audioDir option, or AGENTOS_AUDIO_DIR, to a directory that the service's user owns and no one else can write, under directories that no other user can change (a sticky one such as /tmp is fine), or give the pack a saveAudio.`,
  );
}

/**
 * A host's own saver: it stores the bytes where the host's clients can load
 * them and returns that http(s) URL.
 */
export type SaveAudio = (audio: {
  bytes: Buffer;
  contentType: string;
  tool: string;
  context?: unknown;
}) => string | Promise<string>;

/** Where the tool keeps audio: the directory of the default saver, and a host's own saver when it gave one. */
export interface AudioStore {
  /** The audio directory (see {@link audioDirectory}). */
  dir: string;
  /** The host's saver, which replaces the default. */
  saveAudio?: SaveAudio;
}

/** The store for the pack's options: its `audioDir` and its `saveAudio`, when that is a function. */
export function audioStore(options?: { audioDir?: unknown; saveAudio?: unknown }): AudioStore {
  return {
    dir: audioDirectory(options?.audioDir),
    saveAudio: typeof options?.saveAudio === 'function' ? (options.saveAudio as SaveAudio) : undefined,
  };
}

/**
 * Checks, before a provider is called, that the audio it answers with can be
 * saved for this caller: with no host `saveAudio`, the audio directory and
 * the caller's directory in it are made and checked as a save makes and
 * checks them. A provider bills for the speech it makes, so a directory the
 * saver would refuse is refused first. With a host `saveAudio`, nothing is
 * made or checked on the file system.
 *
 * @throws The error a save would give, naming the directory and the options.
 */
export async function checkAudioStore(store: AudioStore, context?: unknown): Promise<void> {
  if (store.saveAudio) return;
  try {
    await callerDirectory(store.dir, scopeOf(context));
  } catch (error) {
    throw cannotSave(store.dir, error);
  }
}

/** The longest reference a host's saver may return. */
const MAX_REFERENCE_LENGTH = 2048;

/** Whether a saver's result is an http(s) URL short enough to hand to the model. */
function isHttpReference(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REFERENCE_LENGTH) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** A thrown value as text: an Error's message, else its string form (`null` and `undefined` included). */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Saves audio and returns the reference the caller gets: the `file:` URL of a
 * new file in the caller's directory (`agentos-audio-<32 hex>.<ext>`, written
 * `wx` with mode 0600, so a file is never overwritten), or the http(s) URL
 * the host's `saveAudio` returned.
 *
 * @throws When the directory cannot be used, when the host's saver throws, or
 *   when it returns anything but an http(s) URL of at most 2,048 characters.
 */
export async function storeAudio(
  bytes: Buffer,
  audio: { contentType: string; ext: string },
  tool: string,
  store: AudioStore,
  context?: unknown,
): Promise<string> {
  if (!store.saveAudio) {
    try {
      const scopeDir = await callerDirectory(store.dir, scopeOf(context));
      const file = path.join(scopeDir, `agentos-audio-${randomBytes(16).toString('hex')}.${audio.ext}`);
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      return pathToFileURL(file).href;
    } catch (error) {
      throw cannotSave(store.dir, error);
    }
  }
  let reference: unknown;
  try {
    reference = await store.saveAudio({ bytes, contentType: audio.contentType, tool, context });
  } catch (error) {
    throw new Error(`The host's saveAudio failed: ${describeError(error)}`);
  }
  if (!isHttpReference(reference)) {
    throw new Error("The host's saveAudio must return an http(s) URL of at most 2,048 characters.");
  }
  return reference;
}
