import type { AccountSourceConnector, SourceRead } from '../types.js';
import type { SourceCacheDecision, SourceCacheSkipReason } from '../cachePolicy.js';

/** Opaque host-owned keys. Authentication is supplied by the host, never by provider ids. */
export interface SourceSyncScope {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly connectionId: string;
}
/** The six connection states a host shows. Pause is the separate `paused` flag, not a state. */
export type SourceSyncStatus =
  | 'not_connected' | 'connecting' | 'syncing' | 'connected'
  | 'needs_reconnecting' | 'disconnected';
/** The use switches a host applies to a connection's content: search and questions, and live hints. */
export interface SourceSyncUse {
  readonly searchAskEnabled: boolean;
  readonly liveEnabled: boolean;
}
/** Transient failures: the committed cursor stays and a later attempt is scheduled. */
export type SourceSyncRetryReason =
  | 'network' | 'rate_limited' | 'provider_unavailable' | 'storage_unavailable';
/** Fixed failure codes; a code carries no provider message or response body. */
export type SourceSyncFailureCode = SourceSyncRetryReason
  | 'grant_rejected' | 'insufficient_scope' | 'domain_policy'
  | 'history_expired' | 'invalid_response' | 'cancelled';
/** Fixed reasons a source is deliberately not retained: cache refusals and selection, decoding, structure and allowance limits. */
export type SourceSyncSkipReason = SourceCacheSkipReason
  | 'excluded' | 'out_of_window' | 'excluded_label' | 'no_eligible_content'
  | 'response_too_large' | 'structure_limit' | 'unsupported_charset'
  | 'invalid_encoding' | 'document_limit' | 'held_limit' | 'indexing_limit';

/** Counts describe this connection; they carry no remote response estimates or ids. */
export interface SourceSyncProgress {
  readonly examined: number;
  readonly committed: number;
  readonly skipped: number;
  readonly bounded: boolean;
}
/** One connection's durable state. Each control change that fences earlier work raises `generation`. */
export interface SourceSyncState {
  readonly scope: SourceSyncScope;
  readonly status: SourceSyncStatus;
  readonly generation: number;
  readonly revision: number;
  readonly paused: boolean;
  readonly revalidationRequired: boolean;
  readonly use: SourceSyncUse;
  readonly cursor: string | null;
  readonly progress: SourceSyncProgress;
  readonly lastSyncAt: number | null;
  readonly lastRequestedAt: number | null;
  readonly nextSyncAt: number | null;
  readonly retryAt: number | null;
  readonly error: SourceSyncFailureCode | null;
  readonly updatedAt: number;
}

/** Values are policy choices. This library does not assert provider service limits. */
export interface SourceSyncPolicy {
  readonly windowMs: number;
  readonly maxRetainedDocuments: number;
  readonly maxHeldCharacters: number;
  readonly maxIndexedCharacters: number;
  readonly scanPageSize: number;
  readonly maxScanPages: number;
  readonly maxCandidates: number;
  readonly maxChangedPerLease: number;
  readonly maxHistoryPagesPerLease: number;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly manualMinIntervalMs: number;
  readonly reconcileMs: number;
}

/** Owner epoch is checked separately through the released core derivation fence. */
export interface SourceSyncLease {
  readonly scope: SourceSyncScope;
  readonly generation: number;
  readonly token: string;
  readonly expiresAt: number;
}
/** Why a cycle runs: a first pass, history from the committed cursor, a reconciliation pass, or recovery after expired history. */
export type SourceSyncMode = 'bootstrap' | 'incremental' | 'reconcile' | 'recovery';
/** Where a cycle stands: a bounded scan, history replay, or application of the queued work. */
export type SourceSyncPhase = 'scan' | 'history' | 'apply';
/** A cycle's durable resume point. Cursors and page tokens are opaque strings. */
export interface SourceSyncCheckpoint {
  readonly cycleId: string;
  readonly generation: number;
  readonly revision: number;
  readonly mode: SourceSyncMode;
  readonly phase: SourceSyncPhase;
  readonly cutoff: number;
  /**
   * Where history replays from: the profile anchor read before the scan, or the committed cursor for incremental and
   * reconcile work. A reconcile whose committed cursor's history has expired replays from its anchor instead.
   */
  readonly fromCursor: string;
  /**
   * Resume metadata only: the token the next page is read with, at most 4,096 characters, as a page may carry it. Null
   * at phase boundaries, never a committed history id.
   */
  readonly nextPageToken: string | null;
  /**
   * The `scanPageSize` a scan's `nextPageToken` was read under, kept while the scan holds one: a tune that lowers the
   * page size below it ends the scan. Absent at phase boundaries, and from a checkpoint an earlier release wrote, whose
   * token the stored policy's size issued; the first tune that leaves such a scan open keeps that size here.
   */
  readonly pageTokenSize?: number;
  readonly targetCursor: string | null;
  readonly scanPages: number;
  readonly candidates: number;
  readonly historyPages: number;
  readonly bounded: boolean;
}
/** What opening a cycle takes: its id, the connection generation, mode, cutoff and starting anchor. */
export interface SourceSyncCycleInput {
  readonly cycleId: string;
  readonly generation: number;
  readonly mode: SourceSyncMode;
  readonly cutoff: number;
  readonly fromCursor: string;
}

/** One page of a bounded enumeration: candidate ids and the next page's token. */
export interface SourceSyncScanPage {
  readonly kind: 'scan';
  readonly ids: readonly string[];
  /** The token to read the next page with, a nonempty string of at most 4,096 characters; null on the last page. */
  readonly nextPageToken: string | null;
}
/** One page of history: affected ids, the next page's token and the cursor this page reached. */
export interface SourceSyncHistoryPage {
  readonly kind: 'history';
  readonly ids: readonly string[];
  /** The token to read the next page with, a nonempty string of at most 4,096 characters; null on the last page. */
  readonly nextPageToken: string | null;
  readonly cursor: string;
}
/** Either kind of page a provider answers. */
export type SourceSyncPage = SourceSyncScanPage | SourceSyncHistoryPage;
/** The checkpoint a page produces and the ids it queues. */
export interface SourceSyncPageApplication {
  readonly checkpoint: SourceSyncCheckpoint;
  /** Upsert pending reads in the same transaction as this checkpoint revision. */
  readonly enqueueIds: readonly string[];
}

/** A queued source's outcome. Applied, gone and skipped are terminal; pending and retry are not. */
export type SourceSyncWorkDisposition =
  | { readonly kind: 'pending' }
  | { readonly kind: 'retry'; readonly reason: SourceSyncRetryReason; readonly retryAt: number }
  | { readonly kind: 'applied'; readonly version: string }
  | { readonly kind: 'gone' }
  | { readonly kind: 'skipped'; readonly reason: SourceSyncSkipReason };
/** One durable work row: ids, attempts and a disposition, never source content. */
export interface SourceSyncWork {
  readonly cycleId: string;
  readonly generation: number;
  readonly sourceId: string;
  /** Re-discovery on a new page invalidates an earlier applied/read result. */
  readonly discoveredRevision: number;
  readonly attempts: number;
  readonly disposition: SourceSyncWorkDisposition;
}
/** Complete fresh database aggregate, computed with the checkpoint under its lease lock. */
export interface SourceSyncWorkSummary {
  readonly cycleId: string;
  readonly generation: number;
  readonly checkpointRevision: number;
  readonly total: number;
  readonly pending: number;
  readonly retry: number;
  readonly applied: number;
  readonly gone: number;
  readonly skipped: number;
}

/** Offsets count UTF-16 code units in the sanitized SourceRead.content.text. */
export interface SourceSyncMessageSpan {
  readonly messageId: string;
  readonly start: number;
  readonly end: number;
  readonly receivedAt: number;
  readonly windowExpiresAt: number;
  readonly truncated: boolean;
}
/**
 * A message span as a retained copy's provenance keeps it: the read's span with the SHA-256 of its text,
 * `text.slice(start, end)`, in lower-case hex, which the store computes for each copy it writes or refreshes. A copy an
 * earlier release wrote has no `textHash` on its spans. The hash shows which messages of a later read the copy holds
 * unchanged, so that read is charged only its new and changed messages; like the copy's own text hash, it confirms a
 * guessed text, a short message most easily. `leadHash` is the SHA-256 of the text before the span, from the end of
 * the previous span (the start of the text for the first) to its start: the separator and any header lines of the
 * message. A read's lead is free only when it is the text the copy holds before the same message after the same
 * neighbour among the messages the read still holds, itself unchanged, so a changed header line, a changed separator,
 * a message moved after another and the separator after an edited message are charged. Like `textHash`, `leadHash`
 * confirms a guessed lead: a sender, a subject or a date among a message's header lines, a short lead most easily.
 */
export interface SourceSyncStoredMessageSpan extends SourceSyncMessageSpan {
  readonly textHash?: string;
  readonly leadHash?: string;
}
/** A JSON value for document metadata. */
export type SourceSyncJson = null | boolean | number | string
  | readonly SourceSyncJson[] | { readonly [key: string]: SourceSyncJson };
/** Normalized, sanitized content only; transient provider responses never enter this shape. */
export interface SourceSyncDocument {
  readonly read: SourceRead & { readonly content: { readonly text: string } };
  readonly messages: readonly SourceSyncMessageSpan[];
  readonly metadata: Readonly<Record<string, SourceSyncJson>>;
  readonly activityAt: number;
  readonly contentHash: string;
  readonly cache: Extract<SourceCacheDecision, { kind: 'cache' }>;
}
/** What reading one queued source answers: a document, gone, a deliberate skip or a retry. */
export type SourceSyncReadResult =
  | { readonly kind: 'document'; readonly document: SourceSyncDocument }
  | { readonly kind: 'gone'; readonly id: string }
  | { readonly kind: 'skipped'; readonly id: string; readonly reason: SourceSyncSkipReason }
  | { readonly kind: 'retry'; readonly id: string; readonly reason: SourceSyncRetryReason; readonly retryAt: number };

/** Provider request context is process memory, never a serialized queued HTTP request. */
export interface SourceSyncRequest {
  readonly scope: SourceSyncScope;
  readonly generation: number;
  readonly cycleId: string;
  readonly cutoff: number;
  readonly policy: SourceSyncPolicy;
  readonly signal?: AbortSignal;
}
/** One instance is bound to one grant. These calls do no database commit. */
export interface AccountSourceSyncProvider {
  readonly kind: string;
  begin(request: SourceSyncRequest): Promise<string>;
  scanPage(request: SourceSyncRequest, pageToken: string | null): Promise<SourceSyncScanPage>;
  historyPage(request: SourceSyncRequest, fromCursor: string, pageToken: string | null): Promise<SourceSyncHistoryPage>;
  readSource(request: SourceSyncRequest, sourceId: string): Promise<SourceSyncReadResult>;
}
/** Optional capability. An empty selection in the original interface keeps its original meaning. */
export interface ResumableAccountSourceConnector extends AccountSourceConnector {
  readonly sync: AccountSourceSyncProvider;
}

/** A safe event sink accepts only these fields. Scope and provider payloads are excluded. */
export interface SourceSyncEvent {
  readonly kind: 'source_sync';
  readonly state: 'started' | 'progress' | 'yielded' | 'succeeded' | 'retry' | 'reconnect' | 'purged';
  readonly n: number;
  readonly ms?: number;
}
/** Receives content-free sync events. */
export type SourceSyncEventSink = (event: SourceSyncEvent) => void;
/** Whether a sync was scheduled or asked for by the person. */
export type SourceSyncTrigger = 'scheduled' | 'manual';
/**
 * The events that move a connection between states. `policy_changed` stores a policy that changes what the connection
 * keeps and fences the work before it; `policy_tuned` stores one that changes only its operating bounds
 * (`SOURCE_SYNC_OPERATING_BOUNDS`) and fences nothing.
 */
export type SourceSyncTransition =
  | { readonly type: 'connect_started' }
  | { readonly type: 'grant_ready'; readonly use: SourceSyncUse }
  | { readonly type: 'manual_requested' }
  | { readonly type: 'sync_started' }
  | { readonly type: 'sync_progress'; readonly progress: SourceSyncProgress }
  | { readonly type: 'sync_succeeded'; readonly cursor: string; readonly nextSyncAt: number }
  | { readonly type: 'sync_deferred'; readonly reason: SourceSyncRetryReason; readonly retryAt: number }
  | { readonly type: 'sync_failed'; readonly reason: 'domain_policy' | 'invalid_response' }
  | { readonly type: 'grant_lost'; readonly reason: 'grant_rejected' | 'insufficient_scope' }
  | { readonly type: 'disconnect' }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'policy_changed' }
  | { readonly type: 'policy_tuned' }
  | { readonly type: 'use_changed'; readonly use: SourceSyncUse };
