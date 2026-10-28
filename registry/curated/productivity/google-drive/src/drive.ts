/**
 * @fileoverview Drive's REST API for files a person picked, over an injected fetch: a file's metadata, its export or
 * download read under a byte cap, a Doc's export for reading as text, and the connected account. Each call runs under one deadline over the request and the
 * reading of its answer, 60 seconds unless the caller sets another, joined with the caller's signal. A refusal throws
 * {@link DriveRequestError} with Google's status, reason and domain; a call that gets no answer throws
 * {@link DriveNoAnswer} with its reason.
 * @module agentos-ext-google-drive/drive
 */

import { ReadCapExceeded } from '@framers/agentos-ext-account-sources';
import { abortable, callDeadline, cappedBody, discardBody } from './bounded.js';
import { withoutEmbeddedPictures } from './markdown.js';

/** Drive's API origin, under which `/drive/v3` lives. */
export const DRIVE_BASE_URL = 'https://www.googleapis.com';

/**
 * How long one Drive call may take when its caller sets no other deadline, the reading of its answer included: 60
 * seconds, which holds an export of up to Google's 10 MB.
 */
export const DRIVE_TIMEOUT_MS = 60_000;

/** The longest deadline a call takes: the most milliseconds a Node.js timer waits. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** What each Google Workspace type is exported as: a Doc as Markdown, a Sheet's first sheet as CSV, a Slides deck as text. */
export const EXPORT_TYPES: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'text/markdown',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** The metadata a read uses. */
const FILE_FIELDS = 'id,name,mimeType,version,modifiedTime,ownedByMe,size,webViewLink,trashed';

/** The most bytes read of a metadata or account answer. */
const ANSWER_BYTES = 1_048_576;

/** The most bytes read of an error answer for its reason. */
const ERROR_BYTES = 65_536;

/** Where and how a Drive call is made. */
export interface DriveCallOptions {
  /** The fetch the call is made with; the global fetch when absent. */
  fetchImpl?: typeof fetch;
  /** Drive's API origin, under which `/drive/v3` lives; Google's when absent. A test passes its stand-in's. */
  baseUrl?: string;
  /** Cancels the call: once it aborts, the call stops waiting for Drive and throws {@link DriveNoAnswer} `cancelled`. */
  signal?: AbortSignal;
  /**
   * How long the call may take, the reading of its answer included, in whole milliseconds from 1 to 2,147,483,647;
   * {@link DRIVE_TIMEOUT_MS} when absent.
   */
  timeoutMs?: number;
}

/** A file's metadata as Drive answers it. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Drive's version of the file, which reflects every change made to it on the server. */
  version: string | null;
  /** When anyone last changed the file, RFC 3339. */
  modifiedTime: string | null;
  /** Whether the person owns the file; null where Drive does not say, as for an item in a shared drive. */
  ownedByMe: boolean | null;
  /** The file's size in bytes, when Drive states one. */
  size: number | null;
  /** The address that opens the file in Google's editor or viewer. */
  webViewLink: string | null;
  /** Whether the file is in its owner's trash. */
  trashed: boolean;
}

/** The connected account as Drive's `about` answers it. */
export interface DriveAccount {
  /** The account's address, or an empty string where Google leaves it out. */
  emailAddress: string;
  /** The account's display name, or an empty string where Google leaves it out. */
  displayName: string;
}

/** Drive refused a call: the HTTP status and, when its answer named them, Google's error reason and domain. */
export class DriveRequestError extends Error {
  /**
   * @param status The HTTP status Drive answered.
   * @param reason Google's reason, such as `notFound` or `userRateLimitExceeded`, when the answer gave one.
   * @param domain Google's error domain, such as `global` or `usageLimits`, when the answer gave one.
   */
  constructor(readonly status: number, readonly reason?: string, readonly domain?: string) {
    super(`Drive answered ${status}${reason === undefined ? '' : ` (${reason})`}`);
    this.name = 'DriveRequestError';
  }
}

/** Why a call got no answer: its deadline passed, its caller cancelled it, or the connection failed. */
export type DriveNoAnswerReason = 'timeout' | 'cancelled' | 'network';

/**
 * A Drive call that got no answer, or whose answer's body stopped before its end: its deadline passed, its caller
 * cancelled it, or the connection failed. Its message names the reason alone, never an address, a token or a cause.
 */
export class DriveNoAnswer extends Error {
  /** @param reason Why the call got no answer. */
  constructor(readonly reason: DriveNoAnswerReason) {
    super(`Drive gave no answer: ${reason}`);
    this.name = 'DriveNoAnswer';
  }
}

/** Whether an id can name one file in a request's path: an empty id would name Drive's file listing, and a dot segment would be folded out of the address. */
export function isDriveFileId(id: string): boolean {
  return id !== '' && id !== '.' && id !== '..';
}

/** A word of Google's error answer, kept when it is an identifier. */
function word(value: unknown): string | undefined {
  return typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : undefined;
}

/** A string field, or null when the answer has none. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** An answer's body, read up to a number of bytes under its call's deadline. */
type AnswerBody = (maxBytes: number) => Promise<Uint8Array>;

/**
 * A call's deadline in milliseconds: `timeoutMs`, or {@link DRIVE_TIMEOUT_MS} when absent. Throws a `TypeError` for a
 * value that is not a whole number from 1 to 2,147,483,647, which a timer would run after 1 ms.
 */
function deadlineOf(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DRIVE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('timeoutMs is a whole number of milliseconds from 1 to 2147483647');
  }
  return timeoutMs;
}

/**
 * The refusal of a call that did not succeed, with Google's reason and domain read from its answer when it has them. An
 * error answer past its cap, or one that is not Google's error object, is told by its status alone; one whose body
 * stops before its end throws the call's {@link DriveNoAnswer}, since the reason it would have named is unknown.
 */
async function refusal(status: number, body: AnswerBody): Promise<DriveRequestError> {
  let bytes: Uint8Array;
  try {
    bytes = await body(ERROR_BYTES);
  } catch (error) {
    if (error instanceof ReadCapExceeded) return new DriveRequestError(status);
    throw error;
  }
  try {
    const answer = JSON.parse(new TextDecoder().decode(bytes)) as { error?: { errors?: Array<{ reason?: unknown; domain?: unknown }> } } | null;
    const first = answer?.error?.errors?.[0];
    return new DriveRequestError(status, word(first?.reason), word(first?.domain));
  } catch {
    // An answer that is not Google's error object leaves the reason unknown; the status still tells the caller.
    return new DriveRequestError(status);
  }
}

/**
 * Calls Drive with the access token under one deadline over the request and the reading of its answer, joined with the
 * caller's signal, and hands the answer of a success to `read`; anything else throws its refusal. A call whose signal
 * has already aborted throws {@link DriveNoAnswer} `cancelled` before any request. A call that gets no answer by its
 * deadline, whose caller cancels it, whose connection fails or whose answer's body stops before its end throws
 * {@link DriveNoAnswer} with that reason, whatever the fetch does with the signal it is handed; an answer that arrives
 * after that has its body released unread. A body still being read when the call ends is cancelled there, and a body
 * past its cap throws `ReadCapExceeded` at once; neither waits on the stream's cancellation.
 */
async function driveCall<T>(token: string, path: string, options: DriveCallOptions, read: (body: AnswerBody) => Promise<T>): Promise<T> {
  const ms = deadlineOf(options.timeoutMs);
  const caller = options.signal;
  if (caller?.aborted === true) throw new DriveNoAnswer('cancelled');
  const deadline = callDeadline(caller == null ? [] : [caller], ms);
  const noAnswer = (): DriveNoAnswer => new DriveNoAnswer(caller?.aborted === true ? 'cancelled' : deadline.timedOut() ? 'timeout' : 'network');
  try {
    const base = (options.baseUrl ?? DRIVE_BASE_URL).replace(/\/+$/, '');
    let response: Response;
    try {
      response = await abortable(
        (options.fetchImpl ?? fetch)(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: deadline.signal }),
        deadline.signal,
        noAnswer,
        discardBody,
      );
    } catch (error) {
      // The fetch's own error would name the address or its cause; the reason is all a caller acts on.
      if (error instanceof DriveNoAnswer) throw error;
      throw noAnswer();
    }
    const body: AnswerBody = async (maxBytes) => {
      try {
        return await cappedBody(response, maxBytes, deadline.signal, noAnswer, noAnswer);
      } catch (error) {
        if (error instanceof ReadCapExceeded || error instanceof DriveNoAnswer) throw error;
        throw noAnswer();
      }
    };
    if (!response.ok) throw await refusal(response.status, body);
    return await read(body);
  } finally {
    deadline.end();
  }
}

/** A JSON object answer, read under a cap. */
async function readObject(body: AnswerBody): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(new TextDecoder().decode(await body(ANSWER_BYTES)));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Drive answered something other than an object');
  return value as Record<string, unknown>;
}

/** A file's path in the API. Throws a `TypeError` for an id that cannot name one file. */
function filePath(id: string): string {
  if (!isDriveFileId(id)) throw new TypeError('a Drive file id is required');
  return `/drive/v3/files/${encodeURIComponent(id)}`;
}

/**
 * A file's metadata: its name, type, version, owner, size, link and whether it is trashed. Asks with
 * `supportsAllDrives=true`, without which Drive answers an item of a shared drive as not found.
 */
export async function driveFile(token: string, id: string, options: DriveCallOptions = {}): Promise<DriveFile> {
  const answer = await driveCall(token, `${filePath(id)}?${new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: 'true' })}`, options, readObject);
  const fileId = text(answer.id);
  const name = text(answer.name);
  const mimeType = text(answer.mimeType);
  if (fileId === null || name === null || mimeType === null) throw new Error('Drive answered a file without its id, name or type');
  const size = text(answer.size);
  return {
    id: fileId,
    name,
    mimeType,
    version: text(answer.version),
    modifiedTime: text(answer.modifiedTime),
    ownedByMe: typeof answer.ownedByMe === 'boolean' ? answer.ownedByMe : null,
    size: size !== null && /^\d+$/.test(size) ? Number(size) : null,
    webViewLink: text(answer.webViewLink),
    trashed: answer.trashed === true,
  };
}

/**
 * A Google Workspace file exported as `mimeType` (see {@link EXPORT_TYPES}), read up to `maxBytes`. Google refuses an
 * export past 10 MB; a longer answer than `maxBytes` throws `ReadCapExceeded`.
 */
export async function exportFile(token: string, id: string, mimeType: string, maxBytes: number, options: DriveCallOptions = {}): Promise<Uint8Array> {
  return driveCall(token, `${filePath(id)}/export?${new URLSearchParams({ mimeType })}`, options, (body) => body(maxBytes));
}

/** What {@link exportDoc} reads a Doc as: its Markdown, or its text when the Markdown is past a byte cap. */
export type DocExportType = 'text/markdown' | 'text/plain';

/** Google's reason for an export past its 10 MB limit. */
const EXPORT_CAP_REASON = 'exportSizeLimitExceeded';

/** Whether an export failed on a byte cap: Google's refusal past its 10 MB, or an answer past the caller's `maxBytes`. */
export function exportPastCap(error: unknown): boolean {
  return error instanceof ReadCapExceeded || (error instanceof DriveRequestError && error.status === 403 && error.reason === EXPORT_CAP_REASON);
}

/**
 * A Google Doc exported for reading as text: its Markdown without the pictures Google embeds in it as data addresses
 * (see {@link withoutEmbeddedPictures}), or its text when Google refuses the Markdown past its 10 MB export cap or the
 * Markdown is past `maxBytes`. Google's Markdown export carries every picture of a Doc as a data address, so a Doc of
 * short text and large pictures passes either cap on its pictures alone; its text carries none. A text past a cap too
 * throws that refusal, a {@link DriveRequestError} with the reason `exportSizeLimitExceeded` or a `ReadCapExceeded`, as
 * every other failure of either export throws. Each export is its own call under `options`.
 */
export async function exportDoc(token: string, id: string, maxBytes: number, options: DriveCallOptions = {}): Promise<{ bytes: Uint8Array; mediaType: DocExportType }> {
  try {
    const markdown = await exportFile(token, id, 'text/markdown', maxBytes, options);
    return { bytes: new TextEncoder().encode(withoutEmbeddedPictures(new TextDecoder().decode(markdown))), mediaType: 'text/markdown' };
  } catch (error) {
    if (!exportPastCap(error)) throw error;
  }
  return { bytes: await exportFile(token, id, 'text/plain', maxBytes, options), mediaType: 'text/plain' };
}

/** A file's own bytes (`alt=media`), read up to `maxBytes`; a longer answer throws `ReadCapExceeded`. */
export async function downloadFile(token: string, id: string, maxBytes: number, options: DriveCallOptions = {}): Promise<Uint8Array> {
  return driveCall(token, `${filePath(id)}?${new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' })}`, options, (body) => body(maxBytes));
}

/** The connected account's address and name from Drive's `about`, which the `drive.file` scope may read, so a caller can show which account is connected. */
export async function driveAccount(token: string, options: DriveCallOptions = {}): Promise<DriveAccount> {
  const answer = await driveCall(token, `/drive/v3/about?${new URLSearchParams({ fields: 'user(emailAddress,displayName)' })}`, options, readObject);
  const user: Record<string, unknown> = answer.user !== null && typeof answer.user === 'object' ? (answer.user as Record<string, unknown>) : {};
  return { emailAddress: text(user.emailAddress) ?? '', displayName: text(user.displayName) ?? '' };
}
