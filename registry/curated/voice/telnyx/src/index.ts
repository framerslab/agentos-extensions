// @ts-nocheck
/**
 * @fileoverview Telnyx Voice Call Extension for AgentOS.
 *
 * Provides an IVoiceCallProvider backed by Telnyx Call Control v2,
 * plus an ITool descriptor for programmatic voice call management.
 *
 * @module @framers/agentos-ext-voice-telnyx
 */

import { CallManager, type ExtensionContext, type ExtensionPack } from '@framers/agentos';
import { bindVoiceProvider, type VoiceProviderBinding } from '@framers/agentos/io/channels/telephony/CallManager';
import { TelnyxVoiceService, type TelnyxServiceConfig } from './TelnyxVoiceService';
import { TelnyxVoiceProvider } from './TelnyxVoiceProvider';
import { TelnyxVoiceCallTool } from './tools/voiceCall';

// ============================================================================
// Options
// ============================================================================

export interface TelnyxVoiceOptions {
  /** Telnyx API v2 key (overrides secrets/env). */
  apiKey?: string;
  /** Telnyx Call Control Application connection ID (overrides secrets/env). */
  connectionId?: string;
  /** Ed25519 public key for webhook signature verification. */
  publicKey?: string;
  /** Default E.164 "from" number for outbound calls. */
  fromNumber?: string;
  /** Webhook base URL (e.g., https://yourdomain.com). */
  webhookBaseUrl?: string;
  /** Priority for extension descriptor ordering. */
  priority?: number;
  /** Host-owned manager. The default manager belongs to this pack and is exposed through binding. */
  callManager?: CallManager;
}

/** A raw Telnyx provider carrying the call tool's shared manager binding. */
export type BoundTelnyxVoiceProvider = TelnyxVoiceProvider & { readonly binding: VoiceProviderBinding };
/** Telnyx pack with explicit host access to the call tool's manager. */
export interface TelnyxVoicePack extends ExtensionPack {
  /** Rebinding affects every subsequent tool operation. */
  readonly binding: VoiceProviderBinding;
}

// ============================================================================
// Secret / Env Resolution
// ============================================================================

function resolveApiKey(
  options: TelnyxVoiceOptions,
  secrets?: Record<string, string>,
): string {
  if (options.apiKey) return options.apiKey;
  if (secrets?.['telnyx.apiKey']) return secrets['telnyx.apiKey'];

  for (const envName of ['TELNYX_API_KEY', 'TELNYX_API_V2_KEY']) {
    if (process.env[envName]) return process.env[envName]!;
  }

  throw new Error(
    'Telnyx API key not found. Provide via options.apiKey, secrets["telnyx.apiKey"], or TELNYX_API_KEY env var.',
  );
}

function resolveConnectionId(
  options: TelnyxVoiceOptions,
  secrets?: Record<string, string>,
): string {
  if (options.connectionId) return options.connectionId;
  if (secrets?.['telnyx.connectionId']) return secrets['telnyx.connectionId'];

  for (const envName of ['TELNYX_CONNECTION_ID', 'TELNYX_APP_ID']) {
    if (process.env[envName]) return process.env[envName]!;
  }

  throw new Error(
    'Telnyx connection ID not found. Provide via options.connectionId, secrets["telnyx.connectionId"], or TELNYX_CONNECTION_ID env var.',
  );
}

function resolvePublicKey(
  options: TelnyxVoiceOptions,
  secrets?: Record<string, string>,
): string | undefined {
  if (options.publicKey) return options.publicKey;
  if (secrets?.['telnyx.publicKey']) return secrets['telnyx.publicKey'];
  return process.env['TELNYX_PUBLIC_KEY'] ?? undefined;
}

function resolveFromNumber(options: TelnyxVoiceOptions): string | undefined {
  return options.fromNumber ?? process.env['TELNYX_FROM_NUMBER'] ?? undefined;
}

// ============================================================================
// Factory
// ============================================================================

/** Construct the provider and manager binding without initiating a carrier call. */
export function createExtensionPack(context: ExtensionContext): TelnyxVoicePack {
  const options = (context.options ?? {}) as TelnyxVoiceOptions & {
    secrets?: Record<string, string>;
  };

  const apiKey = resolveApiKey(options, options.secrets);
  const connectionId = resolveConnectionId(options, options.secrets);
  const publicKey = resolvePublicKey(options, options.secrets);
  const fromNumber = resolveFromNumber(options);

  const config: TelnyxServiceConfig = {
    apiKey,
    connectionId,
    publicKey,
    fromNumber,
  };

  // Create service and provider
  const service = new TelnyxVoiceService(config);
  const provider = new TelnyxVoiceProvider(service, config);

  const ownedManager = options.callManager ? undefined : new CallManager({
    provider: { provider: 'telnyx', config: { apiKey, connectionId, fromNumber: fromNumber ?? '' } },
    webhookBaseUrl: options.webhookBaseUrl, defaultMode: 'conversation',
  });
  const binding = bindVoiceProvider(provider, options.callManager ?? ownedManager!);
  Object.defineProperty(provider, 'binding', { value: binding, enumerable: false, writable: false });
  const voiceCallTool = new TelnyxVoiceCallTool(binding.toolHandler);
  const priority = options.priority ?? 50;

  return {
    binding,
    name: '@framers/agentos-ext-voice-telnyx',
    version: '0.1.0',
    descriptors: [
      { id: 'telnyxVoiceCall', kind: 'tool', priority, payload: voiceCallTool },
      { id: 'telnyxVoiceProvider', kind: 'voice-provider', priority, payload: provider },
    ],
    onActivate: async () => {
      await service.initialize();
      context.logger?.info('[TelnyxVoice] Extension activated');
    },
    onDeactivate: async () => {
      ownedManager?.dispose();
      await service.shutdown();
      context.logger?.info('[TelnyxVoice] Extension deactivated');
    },
  };
}

// ── Re-exports ──

export { TelnyxVoiceService, type TelnyxServiceConfig } from './TelnyxVoiceService';
export { TelnyxVoiceProvider } from './TelnyxVoiceProvider';
export { TelnyxVoiceCallTool, type VoiceCallToolHandler } from './tools/voiceCall';
export default createExtensionPack;
