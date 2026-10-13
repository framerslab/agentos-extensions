import type { ExtensionPack, ExtensionPackContext } from '@framers/agentos';
import { EXTENSION_KIND_MEETING_PROVIDER } from '@framers/agentos';
import { BrowserMeetingProvider, type BrowserMeetingProviderOptions } from './BrowserMeetingProvider.js';

/** The pack's options: the provider's, with the client credential optional here since a secret or the environment can supply it. */
export interface BrowserMeetingPackOptions extends Omit<BrowserMeetingProviderOptions, 'schedulerToken'> {
  /** The client credential the scheduler accepts. Default the secret `meetings.schedulerToken`, then the environment. */
  schedulerToken?: string;
  /** The environment name that holds the client credential when `schedulerToken` is absent. Default `MEETING_SCHEDULER_TOKEN`. */
  schedulerTokenEnv?: string;
  /** The descriptor's priority. Default `50`. */
  priority?: number;
}

/**
 * Builds the pack: one `meeting-provider` descriptor, `browserMeetingProvider`, whose payload is a
 * {@link BrowserMeetingProvider} the host registers on its meeting manager. Throws without a scheduler url,
 * a worker id and a client credential.
 */
export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  // The host's options are untyped; every field may be absent until the check below.
  const options = (context.options ?? {}) as Partial<BrowserMeetingPackOptions>;
  const token = options.schedulerToken ?? context.getSecret?.('meetings.schedulerToken') ?? process.env[options.schedulerTokenEnv ?? 'MEETING_SCHEDULER_TOKEN'];
  if (!options.schedulerUrl || !options.workerId || !token) {
    throw new Error('The browser meeting provider needs schedulerUrl, workerId and a scheduler token (options.schedulerToken, the secret meetings.schedulerToken, or MEETING_SCHEDULER_TOKEN).');
  }
  const provider = new BrowserMeetingProvider({ ...options, schedulerUrl: options.schedulerUrl, workerId: options.workerId, schedulerToken: token });
  return {
    name: '@framers/agentos-ext-meeting-browser',
    descriptors: [{ id: 'browserMeetingProvider', kind: EXTENSION_KIND_MEETING_PROVIDER, priority: options.priority ?? 50, payload: provider }],
  };
}

export { BrowserMeetingProvider, classifyJoinUrl } from './BrowserMeetingProvider.js';
export type { BrowserMeetingProviderOptions } from './BrowserMeetingProvider.js';
export * from './protocol.js';
