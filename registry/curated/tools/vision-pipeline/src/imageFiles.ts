// @ts-nocheck
/**
 * @fileoverview Where the image tools keep image data, and how a saved image
 * comes back as a source.
 *
 * A provider that answers with image data (OpenAI's GPT Image models always
 * do) used to have that data returned to the model as a `data:` URL: megabytes
 * of base64 in the next request. The tools save the bytes to a file and return
 * its `file:` URL, or hand them to the host's own saver. A saved file's URL is
 * accepted as a source by the image-editing tools and by `vision-pipeline`.
 * The image-generation, image-editing and vision-pipeline packs each carry
 * this file, the same in all three, so they agree on the directory.
 *
 * The directory is private to the service's user, and each caller has a
 * subdirectory of its own, which is read by the directory's real path and
 * never through a link. That is the trust boundary: only this user can put a
 * file there, so a file there with the saver's name pattern is one the
 * service wrote, for that caller. The directories above it are not checked:
 * a user who can rename one of them can move where images are saved, into
 * another directory this user owns, but cannot make a saved image a source
 * for another caller. A Kubernetes emptyDir is such a parent (0777, with no
 * sticky bit), and a container's /tmp is often one.
 */

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The most bytes of a saved image the tools read back as a source: 50 MiB. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/** The name of a file the saver wrote. */
const SAVED_NAME = /^agentos-image-[0-9a-f]{32}\.(png|jpg|webp)$/;

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The images directory: the pack option `imageDir`, else the environment
 * variable `AGENTOS_IMAGE_DIR`, else a folder in the user's temp directory,
 * which the operating system clears (the packs delete nothing). On POSIX the
 * default carries the user id, since `/tmp` is shared. On Windows it is the
 * user's own temp folder whatever `TEMP` says: `os.tmpdir()` reads `TEMP`,
 * which can name a folder every user shares.
 */
export function imageDirectory(option?: unknown): string {
  const named = [option, process.env.AGENTOS_IMAGE_DIR]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find(Boolean);
  if (named) return path.resolve(named);
  if (typeof process.getuid === 'function') return path.join(os.tmpdir(), `agentos-images-${process.getuid()}`);
  return path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'agentos-images');
}

/**
 * The name of a caller's subdirectory: `u-` and 32 hex characters of the
 * SHA-256 of its user id, or `shared` for a call that carries none. A host
 * with several users gives each call its user (`context.userContext.userId`),
 * so one user's saved image is no source for another.
 */
export function scopeOf(context?: { userContext?: { userId?: unknown } }): string {
  const userId = context?.userContext?.userId;
  return typeof userId === 'string' && userId !== ''
    ? `u-${createHash('sha256').update(userId).digest('hex').slice(0, 32)}`
    : 'shared';
}

/** The kind of image `bytes` are, by their signature: PNG, JPEG or WebP. */
export function imageKind(bytes: Buffer): { ext: 'png' | 'jpg' | 'webp'; mimeType: string } | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { ext: 'png', mimeType: 'image/png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return { ext: 'webp', mimeType: 'image/webp' };
  }
  return undefined;
}

/**
 * Whether a directory's `stat` (taken with `bigint: true`) shows it private
 * to this user: a directory this user owns that neither its group nor others
 * can write. Where the platform has no user ids (Windows) only the kind is
 * checked: the default there is inside the user's own profile.
 */
function isPrivateDirectory(stat: { isDirectory(): boolean; uid: bigint; mode: bigint }): boolean {
  if (!stat.isDirectory()) return false;
  if (typeof process.getuid !== 'function') return true;
  return stat.uid === BigInt(process.getuid()) && (stat.mode & BigInt(0o022)) === BigInt(0);
}

/** The error for a directory that is not private to this user. */
function notPrivate(dir: string): Error {
  return new Error(`${dir} is not a directory that this user owns and no one else can write`);
}

/**
 * The caller's subdirectory of `dir`, by `dir`'s real path, with both made
 * when missing, for this user alone.
 *
 * @throws When either cannot be made, or is not a directory this user owns
 *   that no one else can write; the caller's directory must not be a link.
 */
async function callerDirectory(dir: string, scope: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Written by the real path, so a link swapped in for it later moves nothing.
  const root = await fs.realpath(dir);
  if (!isPrivateDirectory(await fs.stat(root, { bigint: true }))) throw notPrivate(root);
  const scopeDir = path.join(root, scope);
  await fs.mkdir(scopeDir, { recursive: true, mode: 0o700 });
  // lstat: a caller's directory that is a link to another caller's is refused.
  if (!isPrivateDirectory(await fs.lstat(scopeDir, { bigint: true }))) throw notPrivate(scopeDir);
  // A directory this user owns can still refuse a new file: its mode (0500),
  // or a file system mounted read-only.
  await fs.access(scopeDir, fsConstants.W_OK | fsConstants.X_OK);
  return scopeDir;
}

/** The error of a save that cannot use `dir`: it names the directory and the option that sets it. */
function cannotSave(dir: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `The image could not be saved under ${dir}: ${reason}. Set the pack's imageDir option, or AGENTOS_IMAGE_DIR, to a directory that the service's user owns and no one else can write.`,
  );
}

/**
 * Saves image bytes as a new file in the caller's subdirectory of `dir` and
 * returns its `file:` URL. The extension comes from the bytes' signature, and
 * the name is random, so a file is never overwritten.
 *
 * @throws When the bytes are not a PNG, JPEG or WebP image, or when the
 *   directory cannot be made, is not private to this user, or cannot be
 *   written. The message names the directory and the option that sets it.
 */
export async function saveImageFile(bytes: Buffer, dir: string, scope: string): Promise<string> {
  const kind = imageKind(bytes);
  if (!kind) throw new Error('The provider returned data that is not a PNG, JPEG or WebP image.');
  try {
    const scopeDir = await callerDirectory(dir, scope);
    const file = path.join(scopeDir, `agentos-image-${randomBytes(16).toString('hex')}.${kind.ext}`);
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return pathToFileURL(file).href;
  } catch (error) {
    throw cannotSave(dir, error);
  }
}

/**
 * The bytes of the saved image that `source` names, or `undefined` when
 * `source` is not the `file:` URL of an image the saver wrote for this
 * caller. Every reason gives `undefined`, so the caller's one refusal does
 * not tell which files exist.
 *
 * The file must carry the saver's name pattern and sit directly in the
 * caller's subdirectory of the images directory's real path: the same
 * directory by device and inode, itself a directory and not a link, private
 * to this user, as the images directory is. It must be a regular file with
 * one link and at most {@link MAX_SOURCE_BYTES}, and start with a PNG, JPEG
 * or WebP signature. It is opened once, without following a link, and read
 * from that handle.
 */
export async function readSavedImage(source: string, dir: string, scope: string): Promise<Buffer | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    const url = new URL(source);
    if (url.protocol !== 'file:' || url.hostname !== '') return undefined;
    const named = fileURLToPath(url);
    if (!SAVED_NAME.test(path.basename(named))) return undefined;
    // fs.promises.realpath asks the operating system. (fs.realpathSync and
    // fs.realpath resolve ".." in the text first, as path.resolve does.)
    const real = await fs.realpath(named);
    if (!SAVED_NAME.test(path.basename(real))) return undefined;
    // The images directory as it is now, by its real path, so a directory
    // swapped in for it is read as what it is; and the caller's directory in
    // it by lstat, so a link to another caller's directory is refused.
    const root = await fs.realpath(dir);
    const [rootDir, parent, scopeDir] = await Promise.all([
      fs.stat(root, { bigint: true }),
      fs.stat(path.dirname(real), { bigint: true }),
      fs.lstat(path.join(root, scope), { bigint: true }),
    ]);
    if (!isPrivateDirectory(rootDir) || !isPrivateDirectory(scopeDir)) return undefined;
    if (parent.dev !== scopeDir.dev || parent.ino !== scopeDir.ino) return undefined;
    // A FIFO would hold an open until a writer came; only a regular file is opened.
    if (!(await fs.lstat(real)).isFile()) return undefined;
    handle = await fs.open(
      real,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== BigInt(1) || stat.size > BigInt(MAX_SOURCE_BYTES)) return undefined;
    // Checked again now that the file is open: the path still reaches the
    // file opened, in the caller's directory. A directory above it that
    // another user could swap between the checks above and the open would
    // show here, since only this user can link a file into that directory.
    const [linked, parentNow] = await Promise.all([
      fs.lstat(real, { bigint: true }),
      fs.stat(path.dirname(real), { bigint: true }),
    ]);
    if (linked.dev !== stat.dev || linked.ino !== stat.ino) return undefined;
    if (parentNow.dev !== scopeDir.dev || parentNow.ino !== scopeDir.ino) return undefined;
    // One byte more than the size at open: a file that has grown is refused.
    const size = Number(stat.size);
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > size) return undefined;
    const bytes = buffer.subarray(0, length);
    return imageKind(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** An image as AgentOS's image functions return it. */
export interface ReturnedImage {
  url?: string;
  dataUrl?: string;
  base64?: string;
  mimeType?: string;
}

/**
 * A host's own saver: it stores the bytes where the host's clients can load
 * them and returns that http(s) URL.
 */
export type SaveImage = (image: {
  bytes: Buffer;
  mimeType: string;
  tool: string;
  context?: unknown;
}) => string | Promise<string>;

/** Where the tools keep image data: the directory of the default saver, and a host's own saver when it gave one. */
export interface ImageStore {
  /** The images directory (see {@link imageDirectory}). */
  dir: string;
  /** The host's saver, which replaces the default. */
  saveImage?: SaveImage;
}

/**
 * Checks, before a provider is called, that the image data it may return can
 * be saved for this caller: with no host `saveImage`, the images directory
 * and the caller's directory in it are made and checked as a save makes and
 * checks them. A provider bills for the image it makes, so a directory the
 * saver would refuse is refused first.
 *
 * @throws The error a save would give, naming the directory and the option.
 */
export async function checkImageStore(store: ImageStore, context?: unknown): Promise<void> {
  if (store.saveImage) return;
  try {
    await callerDirectory(store.dir, scopeOf(context));
  } catch (error) {
    throw cannotSave(store.dir, error);
  }
}

/** The store for a pack's options: its `imageDir` and its `saveImage`, when that is a function. */
export function imageStore(options?: { imageDir?: unknown; saveImage?: unknown }): ImageStore {
  return {
    dir: imageDirectory(options?.imageDir),
    saveImage: typeof options?.saveImage === 'function' ? (options.saveImage as SaveImage) : undefined,
  };
}

/** The longest reference a host's saver may return. */
const MAX_REFERENCE_LENGTH = 2048;

/** The bytes of a base64 `data:` URL, the form AgentOS's providers give image data in; `undefined` for anything else. */
function dataUrlBytes(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || !/^data:/i.test(value)) return undefined;
  const comma = value.indexOf(',');
  if (comma === -1 || !/; *base64 *$/i.test(value.slice(0, comma))) return undefined;
  return Buffer.from(value.slice(comma + 1), 'base64');
}

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

/**
 * An image a provider returned, as the reference the caller gets: the
 * provider's http(s) URL as it is, or, for image data, the URL under which
 * it was saved. Image data is never returned itself: as a `data:` URL it
 * would go into the model's next request, megabytes of base64. `undefined`
 * when the provider returned neither a URL nor data.
 *
 * @throws When the data is not a PNG, JPEG or WebP image, when it cannot be
 *   saved, or when the host's saver throws or returns anything but an
 *   http(s) URL of at most 2,048 characters.
 */
export async function storeImage(
  image: ReturnedImage | undefined,
  tool: string,
  store: ImageStore,
  context?: unknown,
): Promise<string | undefined> {
  if (!image) return undefined;
  if (typeof image.url === 'string' && /^https?:\/\//i.test(image.url)) return image.url;
  const bytes =
    typeof image.base64 === 'string' && image.base64 !== ''
      ? Buffer.from(image.base64, 'base64')
      : (dataUrlBytes(image.dataUrl) ?? dataUrlBytes(image.url));
  if (!bytes || bytes.length === 0) return undefined;
  if (!store.saveImage) return saveImageFile(bytes, store.dir, scopeOf(context));
  const kind = imageKind(bytes);
  if (!kind) throw new Error('The provider returned data that is not a PNG, JPEG or WebP image.');
  const reference = await store.saveImage({ bytes, mimeType: kind.mimeType, tool, context });
  if (!isHttpReference(reference)) {
    throw new Error("The host's saveImage must return an http(s) URL of at most 2,048 characters.");
  }
  return reference;
}
