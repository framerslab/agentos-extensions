/**
 * @fileoverview Where an attach session's screenshots are written: one
 * evidence directory, and the checks that keep a write inside it.
 *
 * A screenshot's path comes from a tool argument, so it must not reach the
 * rest of the disk or replace a file. It is read against the evidence
 * directory, refused when it leaves it or passes through a link, and written
 * to a new file only.
 *
 * The directory is private to this user, by the rules the media packs keep
 * for the files they save (`imageFiles.ts`, `audioFiles.ts`). The evidence
 * directory and each directory in it on the way to the file belong to this
 * user and are writable by no one else. Each directory above the evidence
 * directory belongs to this user or root and is writable by no one else
 * unless it is sticky, as /tmp is. A user who could rename an entry on that
 * path could swap a directory for a link between the checks and the write,
 * and Node has no `openat` to create a file in a checked directory. On
 * Windows, where Node reads no ACLs, only the directories' kind is checked.
 *
 * A page takes seconds to capture, so the directories are checked twice:
 * before the capture, so that nothing is asked of the browser for a path
 * that will be refused, and again around the creation of the file, before
 * the image is written through its handle.
 *
 * @module browser-automation/attach/evidence
 */
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AttachError } from './errors.js';

/** The evidence directory when none is configured. */
export const DEFAULT_EVIDENCE_DIR = join(homedir(), '.wunderland', 'attach-evidence');

/** A directory as it was checked: its path and its identity on the file system. */
interface CheckedDirectory {
  path: string;
  dev: bigint;
  ino: bigint;
}

/** A screenshot's file, prepared by {@link prepareEvidenceFile}. */
export interface PreparedEvidence {
  /** The file to create, inside the evidence directory's real path. */
  target: string;
  /** The evidence directory, then each directory in it on the way to the file, as checked. */
  directories: readonly CheckedDirectory[];
}

const blocked = (message: string) => new AttachError('POLICY_BLOCKED', message);

/** A mode's permission bits as four octal digits. */
const octal = (mode: bigint) => (mode & 0o7777n).toString(8).padStart(4, '0');

/**
 * The path inside `root` that `filePath` names when read against it, or
 * `undefined` when it names `root` itself or a place outside it.
 */
function insideOf(root: string, filePath: string): string | undefined {
  const inside = relative(root, resolve(root, filePath));
  return inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? undefined : inside;
}

/**
 * Refuses, by the text of the path alone, a path that names no file, and a
 * relative path that leaves the evidence directory. A relative path reads the
 * same against the directory however the directory is named, so it is settled
 * here, before the disk is touched. An absolute path is settled by
 * {@link nameInside}, once the directory's real path is known.
 *
 * @throws POLICY_BLOCKED
 */
function checkName(filePath: string, configured: string): void {
  if (
    typeof filePath !== 'string' ||
    !filePath.trim() ||
    filePath.includes('\0') ||
    filePath.endsWith('/') ||
    filePath.endsWith(sep)
  ) {
    throw blocked('screenshot path must name a file inside the evidence directory');
  }
  if (!isAbsolute(filePath) && insideOf(configured, filePath) === undefined) {
    throw blocked(`screenshot path must stay inside the evidence directory (${configured})`);
  }
}

/**
 * The path inside the evidence directory that `filePath` names. An absolute
 * path may name the directory by its real path (`root`), as a result of
 * {@link prepareEvidenceFile} does, or as it is configured.
 *
 * @throws POLICY_BLOCKED when the path is outside the directory.
 */
function nameInside(filePath: string, configured: string, root: string): string {
  const inside = insideOf(root, filePath) ?? insideOf(configured, filePath);
  if (inside === undefined) {
    throw blocked(`screenshot path must stay inside the evidence directory (${root})`);
  }
  return inside;
}

/**
 * `dir` as a directory private to this user: a directory, not a link, that
 * this user owns and that neither its group nor others can write. Where the
 * platform has no user ids (Windows) only the kind is checked.
 *
 * @throws POLICY_BLOCKED when it is anything else.
 */
async function privateDirectory(dir: string): Promise<CheckedDirectory> {
  const stat = await lstat(dir, { bigint: true });
  if (!stat.isDirectory()) {
    throw blocked(`screenshot path passes through ${dir}, which is not a directory (a link is refused)`);
  }
  if (typeof process.getuid === 'function' && (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o022n) !== 0n)) {
    throw blocked(
      `${dir} must belong to this user and be writable by no one else (owner uid ${stat.uid}, mode ${octal(stat.mode)}): chmod 700 it, or set another evidence directory`,
    );
  }
  return { path: dir, dev: stat.dev, ino: stat.ino };
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
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    const stat = await lstat(parent, { bigint: true });
    if (!stat.isDirectory()) return `${parent}, above it, is not a directory`;
    if (stat.uid !== uid && stat.uid !== 0n) {
      return `${parent}, above it, belongs to uid ${stat.uid} (mode ${octal(stat.mode)})`;
    }
    if ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n) {
      return `${parent}, above it, can be written by others and is not sticky (owner uid ${stat.uid}, mode ${octal(stat.mode)})`;
    }
    if (dirname(parent) === parent) return undefined;
  }
}

/** Whether each checked directory is still that directory: the same device and inode, and not a link. */
async function unchanged(directories: readonly CheckedDirectory[]): Promise<boolean> {
  for (const checked of directories) {
    const now = await lstat(checked.path, { bigint: true }).catch(() => undefined);
    if (!now?.isDirectory() || now.dev !== checked.dev || now.ino !== checked.ino) return false;
  }
  return true;
}

/**
 * The path a screenshot at `filePath` would be written to, for a dry run:
 * the same reading of the path as {@link prepareEvidenceFile}, with nothing
 * made on the disk. The evidence directory is named by its real path when it
 * exists, as a written screenshot's path is.
 *
 * @param evidenceDir - The configured evidence directory, or `undefined` for the default.
 * @param filePath - The path asked for, relative to the directory or absolute inside it.
 * @throws POLICY_BLOCKED when the path names no file or leaves the directory.
 */
export async function plannedEvidencePath(evidenceDir: string | undefined, filePath: string): Promise<string> {
  const configured = resolve(evidenceDir ?? DEFAULT_EVIDENCE_DIR);
  checkName(filePath, configured);
  const root = await realpath(configured).catch(() => configured);
  return join(root, nameInside(filePath, configured, root));
}

/**
 * Prepares the file a screenshot is written to, before the page is captured.
 * The evidence directory is made when missing (mode 0700) and read by its
 * real path, so a link swapped in for it later moves nothing. Each directory
 * from it to the file is made (mode 0700) or checked: a directory, not a
 * link, private to this user, with no directory above the evidence directory
 * that another user can change. A file already at the path is refused.
 *
 * @param evidenceDir - The configured evidence directory, or `undefined` for the default.
 * @param filePath - The path asked for, relative to the directory or absolute inside it.
 * @throws POLICY_BLOCKED for a path that names no file, leaves the directory,
 *   passes through a link or a file, or names something that exists, and for
 *   a directory that is not private to this user.
 * @throws UNKNOWN when the directory cannot take a new file (its mode, or a
 *   file system mounted read-only).
 */
export async function prepareEvidenceFile(evidenceDir: string | undefined, filePath: string): Promise<PreparedEvidence> {
  const configured = resolve(evidenceDir ?? DEFAULT_EVIDENCE_DIR);
  checkName(filePath, configured);
  await mkdir(configured, { recursive: true, mode: 0o700 });
  const root = await realpath(configured);
  const target = join(root, nameInside(filePath, configured, root));
  const directories = [await privateDirectory(root)];
  const changeable = await changeableParent(root);
  if (changeable) {
    throw blocked(`the evidence directory ${root} cannot be used: ${changeable}. Set one under directories that no other user can change`);
  }
  let dir = root;
  for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    dir = join(dir, part);
    await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      // Something is there already: the check below says whether it will do.
      if (err.code !== 'EEXIST') throw err;
    });
    directories.push(await privateDirectory(dir));
  }
  if (await lstat(target).catch(() => undefined)) {
    throw blocked(`a file is already at ${target}: a screenshot never replaces one`);
  }
  // A directory this user owns can still refuse a new file: asked now, not
  // after the page is captured.
  await access(dir, fsConstants.W_OK | fsConstants.X_OK).catch((err: NodeJS.ErrnoException) => {
    throw new AttachError('UNKNOWN', `${dir} cannot take a new file (${err.code ?? err.message})`);
  });
  return { target, directories };
}

/**
 * Creates the prepared file and writes `bytes` to it.
 *
 * The directories are checked to be the ones prepared, the file is created
 * with flag `wx` (it never replaces a file, and a link at its name is not
 * followed), and with the file open the directories are checked again and the
 * file is checked to be the one at its path, with no other name. Only then
 * are the bytes written, through the handle. Node has no `openat`, so this is
 * the order that keeps an image out of a directory swapped in while the page
 * was captured: a file created in the wrong place stays empty.
 *
 * A write that fails removes the file it made, so no partial image is left.
 *
 * @throws POLICY_BLOCKED when a file is already there or a directory changed.
 */
export async function writeEvidenceFile(prepared: PreparedEvidence, bytes: Buffer): Promise<void> {
  const changed = () => blocked('the evidence directory changed while the page was captured; no image was written');
  if (!(await unchanged(prepared.directories))) throw changed();
  let handle: FileHandle;
  try {
    handle = await open(prepared.target, 'wx', 0o600);
  } catch (err) {
    throw (err as NodeJS.ErrnoException).code === 'EEXIST'
      ? blocked(`a file is already at ${prepared.target}: a screenshot never replaces one`)
      : err;
  }
  try {
    const file = await handle.stat({ bigint: true });
    const named = await lstat(prepared.target, { bigint: true }).catch(() => undefined);
    const inPlace =
      file.isFile() && file.nlink === 1n && named !== undefined && named.dev === file.dev && named.ino === file.ino;
    if (!inPlace || !(await unchanged(prepared.directories))) throw changed();
    try {
      await handle.writeFile(bytes);
    } catch (err) {
      // The file was checked, a moment ago, to be the one at this path.
      await unlink(prepared.target).catch(() => {});
      throw err;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}
