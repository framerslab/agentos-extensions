// @ts-nocheck
/**
 * @file index.ts
 * @description Pack factory for the Google Cloud TTS extension pack.
 *
 * Exports the main {@link createGoogleCloudTTS} factory function and the
 * {@link createExtensionPack} bridge function that conforms to the AgentOS
 * manifest factory convention.
 *
 * ### Usage (direct)
 * ```ts
 * import { createGoogleCloudTTS } from '@framers/agentos-ext-google-cloud-tts';
 *
 * const tts = createGoogleCloudTTS('/path/to/service-account.json');
 * const result = await tts.synthesize('Hello, world!');
 * // result.audioBuffer — raw MP3 bytes
 * ```
 *
 * ### Usage (manifest-driven)
 * ```json
 * { "packs": [{ "module": "@framers/agentos-ext-google-cloud-tts" }] }
 * ```
 *
 * @module google-cloud-tts
 */

import { GoogleCloudTTSProvider } from './GoogleCloudTTSProvider.js';

// ---------------------------------------------------------------------------
// Local interface mirrors — avoids a hard runtime dep on @framers/agentos
// ---------------------------------------------------------------------------

/** Subset of ExtensionDescriptor required by this pack. */
interface ExtensionDescriptor {
  id: string;
  kind: string;
  payload: unknown;
  enableByDefault?: boolean;
  metadata?: Record<string, unknown>;
}

/** Subset of ExtensionPack required by this pack. */
interface ExtensionPack {
  id: string;
  descriptors: ExtensionDescriptor[];
}

/** Subset of ExtensionPackContext required by this pack. */
interface ExtensionPackContext {
  getSecret?: (id: string) => string | undefined;
  options?: Record<string, unknown>;
}

/** Kind constant matching packages/agentos/src/extensions/types.ts. */
const EXTENSION_KIND_TTS = 'tts-provider';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Create a standalone {@link GoogleCloudTTSProvider} instance.
 *
 * @param credentials - Path to service-account JSON file or inline JSON string.
 * @returns Configured {@link GoogleCloudTTSProvider}.
 */
export function createGoogleCloudTTS(credentials: string): GoogleCloudTTSProvider {
  return new GoogleCloudTTSProvider(credentials);
}

/**
 * AgentOS manifest factory function.
 *
 * Reads the `GOOGLE_CLOUD_TTS_CREDENTIALS` secret from the context, else the environment
 * variable of the same name, and
 * returns an {@link ExtensionPack} containing a single `tts-provider`
 * descriptor backed by {@link GoogleCloudTTSProvider}.
 *
 * @param context - Pack context supplied by the extension manager.
 * @returns A fully configured {@link ExtensionPack}.
 */
export function createExtensionPack(context: ExtensionPackContext): ExtensionPack {
  // The secret, else the environment variable of the same name. AgentOS's
  // extension manager reads the environment only for the ids in its own
  // catalog, which has neither speech pack's, and a value left unread would
  // leave the client on Application Default Credentials without a word.
  const credentials =
    [context.getSecret?.('GOOGLE_CLOUD_TTS_CREDENTIALS'), process.env.GOOGLE_CLOUD_TTS_CREDENTIALS].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    ) ?? '';
  const provider = new GoogleCloudTTSProvider(credentials);

  return {
    id: 'google-cloud-tts',
    descriptors: [
      {
        id: 'google-cloud-tts',
        kind: EXTENSION_KIND_TTS,
        payload: provider,
        enableByDefault: true,
        metadata: { providerId: 'google-cloud-tts' },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { GoogleCloudTTSProvider } from './GoogleCloudTTSProvider.js';
export type {
  SpeechVoice,
  SynthesisResult,
  GoogleCloudTTSOptions,
} from './GoogleCloudTTSProvider.js';
