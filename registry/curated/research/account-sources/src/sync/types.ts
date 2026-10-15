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
  /** Where history replays from: the profile anchor read before the scan, or the committed cursor for incremental and reconcile work. */
  readonly fromCursor: string;
  /** Resume metadata only. Null at phase boundaries, never a committed history id. */
  readonly nextPageToken: string | null;
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
  readonly nextPageToken: string | null;
}
/** One page of history: affected ids, the next page's token and the cursor this page reached. */
export interface SourceSyncHistoryPage {
  readonly kind: 'history';
  readonly ids: readonly string[];
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
/** The events that move a connection between states. */
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
  | { readonly type: 'use_changed'; readonly use: SourceSyncUse };
