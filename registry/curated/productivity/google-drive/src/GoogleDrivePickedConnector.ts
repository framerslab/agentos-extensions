/**
 * @fileoverview The files a person picked in Google Drive as an account source: each read by id under the
 * `drive.file` scope, a Google Workspace file exported and any other downloaded, and a file that can no longer be
 * read answered gone with its reason.
 * @module agentos-ext-google-drive/GoogleDrivePickedConnector
 */

import { ReadCapExceeded, type AccountSourceConnector, type SourceChanges, type SourceGone, type SourceItem, type SourceRead, type SourceSelection } from '@framers/agentos-ext-account-sources';
import { downloadFile, driveFile, DriveRequestError, EXPORT_TYPES, exportFile, isDriveFileId, type DriveCallOptions, type DriveFile } from './drive.js';

/** The kind each read's `SourceRef` carries. */
const KIND = 'google_drive';

/** The prefix of Google Workspace types, which have no bytes of their own to download. */
const WORKSPACE_TYPE = 'application/vnd.google-apps.';

/** Google's reasons for its rate and quota limits, which pass. */
const LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded']);

/** How the connector reads. */
export interface GoogleDrivePickedOptions {
  /** Answers a file whose `ownedByMe` is not true as `not_owned`, without reading its content. */
  ownedOnly: boolean;
  /** The most bytes a file's content may take; a file past it is answered `removed`. */
  maxFileBytes: number;
  /** The fetch Drive is called with; the global fetch when absent. */
  fetchImpl?: typeof fetch;
  /** Drive's API origin; Google's when absent. A test passes its stand-in's. */
  baseUrl?: string;
  /** What `revoke()` calls, such as the caller's `GoogleOAuthFlow.forget(key)`. */
  revoke?: () => Promise<unknown>;
}

/** The type a Google Workspace file is exported as, or undefined for any other file. */
function exportTypeOf(mimeType: string): string | undefined {
  return Object.hasOwn(EXPORT_TYPES, mimeType) ? EXPORT_TYPES[mimeType] : undefined;
}

/**
 * Why Drive's refusal means the file cannot be read, or null for anything that says nothing about the file, which the
 * caller sees thrown and tries again: a rate or quota limit (Drive answers them as 403 or 429), a token Drive refused,
 * a server's fault, an answer that is not Google's error object, such as a proxy's or a wrong address's 404, and a
 * `ReadCapExceeded`. A read past its cap answers a file gone only when it is the file's content past `maxFileBytes`,
 * which `content` answers `removed` itself; a metadata answer past its 1 MiB cap, such as a proxy's page, throws.
 */
function goneReasonOf(error: unknown): SourceGone['reason'] | null {
  if (!(error instanceof DriveRequestError)) return null;
  const { status, reason, domain } = error;
  if (reason === undefined) return null;
  if (status === 404) return 'removed';
  if (status !== 403 || domain === 'usageLimits' || LIMIT_REASONS.has(reason)) return null;
  return reason === 'exportSizeLimitExceeded' ? 'removed' : 'no_access';
}

/** A file as an item of the account, under the id it was asked by; its size where reading it downloads that size. */
function itemOf(id: string, file: DriveFile): SourceItem {
  return { id, title: file.name, size: exportTypeOf(file.mimeType) === undefined ? file.size : null, version: file.version };
}

/** The cursor's versions by file id: a JSON object of each file's id to the version it was read at. */
function versionsOf(cursor: string | null): Map<string, string | null> {
  const versions = new Map<string, string | null>();
  if (cursor === null) return versions;
  const parsed: unknown = JSON.parse(cursor);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('the cursor is not a JSON object of file ids to versions');
  for (const [id, version] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof version === 'string' || version === null) versions.set(id, version);
    else throw new TypeError('the cursor is not a JSON object of file ids to versions');
  }
  return versions;
}

/**
 * The files a person picked in Google Drive, read by id under the `drive.file` scope. A Google Doc is exported as
 * Markdown, a Sheet as CSV and a Slides deck as text; any other file is downloaded; every file is answered as bytes
 * with the type it was read as, for the caller's loader of that type. A file that can no longer be read is answered
 * gone: `removed` when Drive answers it not found, when it is in the trash, when it is a Google Workspace type with no
 * export or when its content is past Google's 10 MB export cap or `maxFileBytes`; `no_access` when Drive refuses it;
 * and `not_owned`, without reading its content, when `ownedOnly` is set and Drive does not say the person owns it.
 * Drive's rate limits, a refused token, a server's fault and a metadata answer past its 1 MiB cap throw.
 */
export class GoogleDrivePickedConnector implements AccountSourceConnector {
  /** Each read's `SourceRef.kind`. */
  readonly kind = KIND;

  /**
   * @param accessToken Answers an access token for the grant, such as the caller's `GoogleOAuthFlow.accessToken(key)`.
   * @param options Whether only the person's own files are read, the byte cap, and where Drive is called.
   */
  constructor(private readonly accessToken: () => Promise<string>, private readonly options: GoogleDrivePickedOptions) {}

  /** Lists the picked files with their versions, and those that can no longer be read. */
  async list(selection: SourceSelection, signal?: AbortSignal): Promise<{ items: SourceItem[]; gone: SourceGone[] }> {
    signal?.throwIfAborted();
    let token: string | undefined;
    const items: SourceItem[] = [];
    const gone: SourceGone[] = [];
    for (const id of selection.ids) {
      if (!isDriveFileId(id)) {
        gone.push({ id, reason: 'removed' });
        continue;
      }
      token ??= await this.accessToken();
      const found = await this.metadata(token, id, signal);
      if ('reason' in found) gone.push(found);
      else items.push(itemOf(id, found));
    }
    return { items, gone };
  }

  /** Reads one picked file: its metadata first, then its export or its bytes, with its attribution; or why it is gone. */
  async read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone> {
    signal?.throwIfAborted();
    if (!isDriveFileId(item.id)) return { id: item.id, reason: 'removed' };
    const token = await this.accessToken();
    const found = await this.metadata(token, item.id, signal);
    if ('reason' in found) return found;
    const content = await this.content(token, found, signal);
    if (typeof content === 'string') return { id: item.id, reason: content };
    return {
      item: itemOf(item.id, found),
      content,
      ref: { kind: KIND, title: found.name, url: found.webViewLink, version: found.version, readAt: new Date().toISOString() },
    };
  }

  /**
   * The picked files whose `version` is not the one the cursor holds (every readable file when the cursor is null),
   * those that can no longer be read, and the next cursor: a JSON object of each readable file's id to its version.
   * Throws a `TypeError` for a cursor of another shape, before Drive is asked.
   */
  async changesSince(cursor: string | null, selection: SourceSelection, signal?: AbortSignal): Promise<SourceChanges> {
    const before = versionsOf(cursor);
    const { items, gone } = await this.list(selection, signal);
    const changed = items.filter((item) => !before.has(item.id) || before.get(item.id) !== item.version);
    return { changed, gone, cursor: JSON.stringify(Object.fromEntries(items.map((item): [string, string | null] => [item.id, item.version]))) };
  }

  /** Ends the grant through the `revoke` the connector was given, which revokes it at Google and clears it where it is kept. */
  async revoke(): Promise<void> {
    if (this.options.revoke === undefined) throw new Error('no revoke function was given to this connector');
    await this.options.revoke();
  }

  /** Where Drive is called, with this call's signal. */
  private call(signal?: AbortSignal): DriveCallOptions {
    return { fetchImpl: this.options.fetchImpl, baseUrl: this.options.baseUrl, signal };
  }

  /** A picked file's metadata, or why it can no longer be read. */
  private async metadata(token: string, id: string, signal?: AbortSignal): Promise<DriveFile | SourceGone> {
    const found = await driveFile(token, id, this.call(signal)).catch((error: unknown): SourceGone => {
      const reason = goneReasonOf(error);
      if (reason === null) throw error;
      return { id, reason };
    });
    if ('reason' in found) return found;
    if (found.trashed) return { id, reason: 'removed' };
    if (this.options.ownedOnly && found.ownedByMe !== true) return { id, reason: 'not_owned' };
    return found;
  }

  /** A file's content, exported or downloaded under the byte cap, or why it cannot be read. */
  private async content(token: string, file: DriveFile, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string } | SourceGone['reason']> {
    const exportType = exportTypeOf(file.mimeType);
    try {
      if (exportType !== undefined) return { bytes: await exportFile(token, file.id, exportType, this.options.maxFileBytes, this.call(signal)), mediaType: exportType };
      // A folder, a shortcut or another Google Workspace type has no export here and no bytes to download.
      if (file.mimeType.startsWith(WORKSPACE_TYPE)) return 'removed';
      if (file.size !== null && file.size > this.options.maxFileBytes) return 'removed';
      return { bytes: await downloadFile(token, file.id, this.options.maxFileBytes, this.call(signal)), mediaType: file.mimeType };
    } catch (error) {
      // The file's content past maxFileBytes: the one byte cap that answers a file gone.
      if (error instanceof ReadCapExceeded) return 'removed';
      const reason = goneReasonOf(error);
      if (reason === null) throw error;
      return reason;
    }
  }
}
