import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';
import { EXTENSION_KIND_MEETING_PROVIDER } from '@framers/agentos';
import type { MeetingRunRecord } from '@framers/agentos/io/channels/meetings';
import { ZoomApi } from './api.js';
import { InMemoryZoomTokenStore, ZoomTokenKeeper, type IZoomTokenStore } from './tokens.js';
import { ZoomRtmsProvider, type ZoomRtmsProviderOptions } from './ZoomRtmsProvider.js';

/** The pack's options as a host passes them to {@link createExtensionPack}: the Zoom app, the media worker, the secrets (or their names in the host's secret store), the token store and the host's hooks. */
export interface ZoomRtmsPackOptions {
  clientId: string;
  /** The redirect address registered with the Zoom app. */
  redirectUri: string;
  workerUrl: string;
  workerId: string;
  clientSecret?: string;
  webhookSecret?: string;
  workerToken?: string;
  /** Where the owners' connections are kept. Default: in memory, which keeps none across a restart. */
  tokenStore?: IZoomTokenStore;
  runOf?: (runId: string) => Promise<MeetingRunRecord | undefined>;
  onDeauthorized?: ZoomRtmsProviderOptions['onDeauthorized'];
  inbox?: ZoomRtmsProviderOptions['inbox'];
  bindConnection?: ZoomRtmsProviderOptions['bindConnection'];
  recordUsage?: ZoomRtmsProviderOptions['recordUsage'];
  oauthBaseUrl?: string;
  apiBaseUrl?: string;
  priority?: number;
}

/** The pack's entry point: builds the token keeper, the API client and the provider from the options and the secrets, and registers the provider as the meeting-provider extension `zoomRtmsMeetingProvider`. */
export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  const options = (context.options ?? {}) as Partial<ZoomRtmsPackOptions>;
  const clientSecret = options.clientSecret ?? context.getSecret?.('zoom.clientSecret') ?? process.env.ZOOM_CLIENT_SECRET;
  const webhookSecret = options.webhookSecret ?? context.getSecret?.('zoom.webhookSecret') ?? process.env.ZOOM_WEBHOOK_SECRET;
  const workerToken = options.workerToken ?? context.getSecret?.('zoom.workerToken') ?? process.env.ZOOM_MEDIA_WORKER_TOKEN;
  if (!options.clientId || !options.redirectUri || !options.workerUrl || !options.workerId || !clientSecret || !webhookSecret || !workerToken) {
    throw new Error('The Zoom RTMS provider needs clientId, redirectUri, workerUrl, workerId, and three secrets: zoom.clientSecret, zoom.webhookSecret and zoom.workerToken (as options, secrets, or ZOOM_CLIENT_SECRET, ZOOM_WEBHOOK_SECRET and ZOOM_MEDIA_WORKER_TOKEN).');
  }
  const tokens = new ZoomTokenKeeper({
    store: options.tokenStore ?? new InMemoryZoomTokenStore(),
    oauth: { clientId: options.clientId, clientSecret, redirectUri: options.redirectUri, oauthBaseUrl: options.oauthBaseUrl },
  });
  const provider = new ZoomRtmsProvider({
    clientId: options.clientId,
    webhookSecret,
    workerUrl: options.workerUrl,
    workerToken,
    workerId: options.workerId,
    tokens,
    api: new ZoomApi({ baseUrl: options.apiBaseUrl }),
    runOf: options.runOf,
    onDeauthorized: options.onDeauthorized,
    inbox: options.inbox,
    bindConnection: options.bindConnection,
    recordUsage: options.recordUsage,
  });
  return {
    name: '@framers/agentos-ext-meeting-zoom-rtms',
    descriptors: [{ id: 'zoomRtmsMeetingProvider', kind: EXTENSION_KIND_MEETING_PROVIDER, priority: options.priority ?? 50, payload: provider }],
  };
}

export { ZoomRtmsProvider, type ZoomRtmsProviderOptions } from './ZoomRtmsProvider.js';
export * from './api.js';
export * from './eligibility.js';
export { parseZoomJoinUrl, type ZoomJoinLink, type ZoomJoinLinkResult } from './links.js';
export * from './oauth.js';
export { ZOOM_RTMS_AUDIO_PRICE_PER_MINUTE_USD, ZOOM_RTMS_BILLING_INCREMENT_SECONDS, zoomStreamingMicro, zoomStreamingReservationMicro } from './prices.js';
export * from './protocol.js';
export * from './sqlStore.js';
export * from './tokens.js';
export * from './webhook.js';
