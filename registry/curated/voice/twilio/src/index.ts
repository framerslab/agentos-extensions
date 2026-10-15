// @ts-nocheck
/**
 * @fileoverview Twilio Voice Call Extension for AgentOS.
 *
 * Provides an IVoiceCallProvider implementation for Twilio, plus an ITool
 * descriptor that lets agents make and manage phone calls programmatically.
 *
 * Follows the same extension-pack pattern as the Telegram channel extension.
 *
 * @module @framers/agentos-ext-voice-twilio
 */

import { CallManager, type ExtensionContext, type ExtensionPack } from '@framers/agentos';
import { bindVoiceProvider, type VoiceProviderBinding } from '@framers/agentos/io/channels/telephony/CallManager';
import { TwilioVoiceService, type TwilioServiceConfig } from './TwilioVoiceService';
import { TwilioVoiceProvider } from './TwilioVoiceProvider';
import { VoiceCallTool } from './tools/voiceCall';

// ============================================================================
// Options
// ============================================================================

export interface TwilioVoiceOptions {
  /** Twilio Account SID. */
  accountSid?: string;
  /** Twilio Auth Token. */
  authToken?: string;
  /** Default E.164 "from" phone number. */
  fromNumber?: string;
  /** Base URL for webhook callbacks (e.g., https://yourdomain.com). */
  webhookBaseUrl?: string;
  /** Env var name for account SID (default: TWILIO_ACCOUNT_SID). */
  accountSidEnv?: string;
  /** Env var name for auth token (default: TWILIO_AUTH_TOKEN). */
  authTokenEnv?: string;
  /** Env var name for from number (default: TWILIO_FROM_NUMBER). */
  fromNumberEnv?: string;
  /** Extension descriptor priority (default: 50). */
  priority?: number;
  /** Secrets map passed from registry. */
  secrets?: Record<string, string>;
  /** Host-owned manager. Omission creates a pack-owned manager exposed through binding. */
  callManager?: CallManager;
}

/** A raw Twilio provider with access to the manager used by its call tool. */
export type BoundTwilioVoiceProvider = TwilioVoiceProvider & { readonly binding: VoiceProviderBinding };
/** Extension pack exposing its call-tool binding without replacing provider descriptors. */
export interface TwilioVoicePack extends ExtensionPack {
  /** Shared binding used by the tool and voice-provider descriptor. */
  readonly binding: VoiceProviderBinding;
}

// ============================================================================
// Secret Resolution
// ============================================================================

function resolveSecret(
  optionValue: string | undefined,
  secrets: Record<string, string> | undefined,
  secretKey: string,
  envVarOverride: string | undefined,
  defaultEnvVar: string,
  ...fallbackEnvVars: string[]
): string {
  // 1. Direct option value
  if (optionValue) return optionValue;

  // 2. Secrets map from registry
  if (secrets?.[secretKey]) return secrets[secretKey];

  // 3. Custom env var
  const envName = envVarOverride ?? defaultEnvVar;
  if (process.env[envName]) return process.env[envName]!;

  // 4. Fallback env vars
  for (const v of fallbackEnvVars) {
    if (process.env[v]) return process.env[v]!;
  }

  return '';
}

// ============================================================================
// Factory
// ============================================================================

/** Construct a Twilio pack; no call is initiated until its tool or host requests one. */
export function createExtensionPack(context: ExtensionContext): TwilioVoicePack {
  const options = (context.options ?? {}) as TwilioVoiceOptions;

  const accountSid = resolveSecret(
    options.accountSid,
    options.secrets,
    'twilio.accountSid',
    options.accountSidEnv,
    'TWILIO_ACCOUNT_SID',
  );

  const authToken = resolveSecret(
    options.authToken,
    options.secrets,
    'twilio.authToken',
    options.authTokenEnv,
    'TWILIO_AUTH_TOKEN',
  );

  const fromNumber = resolveSecret(
    options.fromNumber,
    options.secrets,
    'twilio.fromNumber',
    options.fromNumberEnv,
    'TWILIO_FROM_NUMBER',
    'TWILIO_PHONE_NUMBER',
  );

  if (!accountSid || !authToken) {
    throw new Error(
      'Twilio credentials not found. Provide via options.accountSid/authToken, ' +
      'secrets["twilio.accountSid"/"twilio.authToken"], or ' +
      'TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN env vars.',
    );
  }

  const config: TwilioServiceConfig = {
    accountSid,
    authToken,
    fromNumber,
    webhookBaseUrl: options.webhookBaseUrl ?? process.env['TWILIO_WEBHOOK_BASE_URL'],
  };

  // ── Instantiate components ──

  const service = new TwilioVoiceService(config);
  const provider = new TwilioVoiceProvider(service);

  const ownedManager = options.callManager ? undefined : new CallManager({
    provider: { provider: 'twilio', config: { accountSid, authToken, fromNumber } },
    webhookBaseUrl: config.webhookBaseUrl, defaultMode: 'conversation',
  });
  const binding = bindVoiceProvider(provider, options.callManager ?? ownedManager!);
  Object.defineProperty(provider, 'binding', { value: binding, enumerable: false, writable: false });
  const voiceCallTool = new VoiceCallTool(binding.toolHandler);

  const priority = options.priority ?? 50;

  return {
    binding,
    name: '@framers/agentos-ext-voice-twilio',
    version: '0.1.0',
    descriptors: [
      { id: 'twilioVoiceCall', kind: 'tool', priority, payload: voiceCallTool },
      { id: 'twilioVoiceProvider', kind: 'voice-provider', priority, payload: provider },
    ],
    onActivate: async () => {
      await service.initialize();
      context.logger?.info('[TwilioVoice] Extension activated');
    },
    onDeactivate: async () => {
      ownedManager?.dispose();
      await service.shutdown();
      context.logger?.info('[TwilioVoice] Extension deactivated');
    },
  };
}

// ============================================================================
// Exports
// ============================================================================

export { TwilioVoiceService, TwilioVoiceProvider, VoiceCallTool };
export type { TwilioServiceConfig } from './TwilioVoiceService';
export type { VoiceCallToolHandler } from './tools/voiceCall';
export default createExtensionPack;
