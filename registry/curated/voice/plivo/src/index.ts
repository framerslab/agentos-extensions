// @ts-nocheck
/**
 * @fileoverview Plivo Voice Provider Extension for AgentOS.
 *
 * Provides an IVoiceCallProvider implementation backed by the Plivo Voice API,
 * plus an ITool descriptor for programmatic voice call management.
 *
 * @module @framers/agentos-ext-voice-plivo
 */

import { CallManager, type ExtensionContext, type ExtensionPack } from '@framers/agentos';
import { bindVoiceProvider, type VoiceProviderBinding } from '@framers/agentos/io/channels/telephony/CallManager';
import { PlivoVoiceService, type PlivoServiceConfig } from './PlivoVoiceService';
import { createPlivoVoiceProvider, PlivoVoiceProvider } from './PlivoVoiceProvider';
import { PlivoVoiceCallTool } from './tools/voiceCall';

// ============================================================================
// Extension Options
// ============================================================================

export interface PlivoVoiceOptions {
  /** Plivo Auth ID (overrides secrets/env). */
  authId?: string;
  /** Plivo Auth Token (overrides secrets/env). */
  authToken?: string;
  /** E.164 outbound caller ID (overrides secrets/env). */
  fromNumber?: string;
  /** Environment variable name for Auth ID (default: PLIVO_AUTH_ID). */
  authIdEnv?: string;
  /** Environment variable name for Auth Token (default: PLIVO_AUTH_TOKEN). */
  authTokenEnv?: string;
  /** Environment variable name for From Number (default: PLIVO_FROM_NUMBER). */
  fromNumberEnv?: string;
  /** Host-owned manager. Omission creates an exposed pack-owned manager; injected managers are never disposed here. */
  callManager?: CallManager;
  /** Extension priority (default: 50). */
  priority?: number;
}

/** Raw Plivo provider with the same manager binding as its registered call tool. */
export type BoundPlivoVoiceProvider = PlivoVoiceProvider & { readonly binding: VoiceProviderBinding };
/** Plivo extension pack with an accessible and replaceable call manager binding. */
export interface PlivoVoicePack extends ExtensionPack {
  /** Binding shared by the voice-provider descriptor and call tool. */
  readonly binding: VoiceProviderBinding;
}

// ============================================================================
// Secret/Env Resolution
// ============================================================================

function resolveSecret(
  key: string,
  optionsValue: string | undefined,
  secrets: Record<string, string> | undefined,
  secretKey: string,
  envName: string,
  ...envFallbacks: string[]
): string {
  // 1. Direct option
  if (optionsValue) return optionsValue;

  // 2. Secrets map
  if (secrets?.[secretKey]) return secrets[secretKey];

  // 3. Primary environment variable
  if (process.env[envName]) return process.env[envName]!;

  // 4. Fallback env vars
  for (const fallback of envFallbacks) {
    if (process.env[fallback]) return process.env[fallback]!;
  }

  throw new Error(
    `Plivo ${key} not found. Provide via options.${key}, secrets["${secretKey}"], or ${envName} env var.`,
  );
}

// ============================================================================
// Extension Pack Factory
// ============================================================================

/**
 * Create the Plivo Voice Provider extension pack.
 *
 * Resolves credentials from options, secrets map, or environment variables,
 * then creates the PlivoVoiceService, PlivoVoiceProvider, and PlivoVoiceCallTool.
 * The provider is registered on `options.callManager`, or on a pack-owned manager when
 * none is given, and the call tool reaches that manager through the returned `binding`.
 *
 * @param context - Extension context with options, logger, and secrets.
 * @returns An ExtensionPack with tool and voice-provider descriptors and the manager `binding`.
 *
 * @example
 * ```typescript
 * import { createExtensionPack } from '@framers/agentos-ext-voice-plivo';
 *
 * const pack = createExtensionPack({
 *   options: {
 *     authId: 'MAXXXXXXXXXX',
 *     authToken: 'your-auth-token',
 *     fromNumber: '+15551234567',
 *     callManager: myCallManager,
 *   },
 * });
 * ```
 */
export function createExtensionPack(context: ExtensionContext): PlivoVoicePack {
  const options = (context.options ?? {}) as PlivoVoiceOptions & {
    secrets?: Record<string, string>;
  };

  // Resolve credentials
  const authId = resolveSecret(
    'authId',
    options.authId,
    options.secrets,
    'plivo.authId',
    options.authIdEnv ?? 'PLIVO_AUTH_ID',
    'PLIVO_AUTH_ID',
  );

  const authToken = resolveSecret(
    'authToken',
    options.authToken,
    options.secrets,
    'plivo.authToken',
    options.authTokenEnv ?? 'PLIVO_AUTH_TOKEN',
    'PLIVO_AUTH_TOKEN',
  );

  const fromNumber = resolveSecret(
    'fromNumber',
    options.fromNumber,
    options.secrets,
    'plivo.fromNumber',
    options.fromNumberEnv ?? 'PLIVO_FROM_NUMBER',
    'PLIVO_FROM_NUMBER',
    'PLIVO_PHONE_NUMBER',
  );

  // Create service and provider
  const serviceConfig: PlivoServiceConfig = { authId, authToken, fromNumber };
  const service = new PlivoVoiceService(serviceConfig);
  const provider = createPlivoVoiceProvider(service, authToken);

  const ownedManager = options.callManager ? undefined : new CallManager({
    provider: { provider: 'plivo', config: { authId, authToken, fromNumber } },
    defaultMode: 'conversation',
  });
  const binding = bindVoiceProvider(provider, options.callManager ?? ownedManager!);
  Object.defineProperty(provider, 'binding', { value: binding, enumerable: false, writable: false });
  const voiceCallTool = new PlivoVoiceCallTool(binding.toolHandler);

  const priority = options.priority ?? 50;

  return {
    binding,
    name: '@framers/agentos-ext-voice-plivo',
    version: '0.1.0',
    descriptors: [
      { id: 'plivoVoiceCall', kind: 'tool', priority, payload: voiceCallTool },
      { id: 'plivoVoiceProvider', kind: 'voice-provider', priority, payload: provider },
    ],
    onActivate: async () => {
      await service.initialize();
      context.logger?.info('[PlivoVoice] Extension activated');
    },
    onDeactivate: async () => {
      ownedManager?.dispose();
      await service.shutdown();
      context.logger?.info('[PlivoVoice] Extension deactivated');
    },
  };
}

// Re-export public API
export { PlivoVoiceService, type PlivoServiceConfig } from './PlivoVoiceService';
export { PlivoVoiceProvider, createPlivoVoiceProvider } from './PlivoVoiceProvider';
export { PlivoVoiceCallTool, type VoiceCallToolHandler } from './tools/voiceCall';
export default createExtensionPack;
