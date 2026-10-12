// @ts-nocheck
/**
 * @file index.ts
 * @description Pack factory for the Google Cloud STT extension pack.
 *
 * Exports the main {@link createGoogleCloudSTT} factory function and the
 * {@link createExtensionPack} bridge function that conforms to the AgentOS
 * manifest factory convention.
 *
 * ### Usage (direct)
 * ```ts
 * import { createGoogleCloudSTT } from '@framers/agentos-ext-google-cloud-stt';
 *
 * const stt = createGoogleCloudSTT('/path/to/service-account.json');
 * const results = await stt.transcribe({ data: pcmBuffer, sampleRate: 16000 });
 * ```
 *
 * ### Usage (manifest-driven)
 * ```json
 * { "packs": [{ "module": "@framers/agentos-ext-google-cloud-stt" }] }
 * ```
 *
 * @module google-cloud-stt
 */

import { GoogleCloudSTTProvider } from './GoogleCloudSTTProvider.js';

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
const EXTENSION_KIND_STT = 'stt-provider';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Create a standalone {@link GoogleCloudSTTProvider} instance.
 *
 * Use this when composing the provider programmatically outside of the
 * AgentOS extension system.
 *
 * @param credentials - Path to service-account JSON file or inline JSON string.
 * @returns Configured {@link GoogleCloudSTTProvider}.
 */
export function createGoogleCloudSTT(credentials: string): GoogleCloudSTTProvider {
  return new GoogleCloudSTTProvider(credentials);
}

/**
 * AgentOS manifest factory function.
 *
 * Reads the `GOOGLE_CLOUD_STT_CREDENTIALS` secret from the context, else the environment
 * variable of the same name, and
 * returns an {@link ExtensionPack} containing a single `stt-provider`
 * descriptor backed by {@link GoogleCloudSTTProvider}.
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
    [context.getSecret?.('GOOGLE_CLOUD_STT_CREDENTIALS'), process.env.GOOGLE_CLOUD_STT_CREDENTIALS].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    ) ?? '';
  const provider = new GoogleCloudSTTProvider(credentials);

  return {
    id: 'google-cloud-stt',
    descriptors: [
      {
        id: 'google-cloud-stt',
        kind: EXTENSION_KIND_STT,
        payload: provider,
        enableByDefault: true,
        metadata: { providerId: 'google-cloud-stt' },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { GoogleCloudSTTProvider } from './GoogleCloudSTTProvider.js';
export type {
  SpeechTranscriptionResult,
  SpeechTranscriptionSegment,
  GoogleCloudSTTOptions,
  AudioData,
} from './GoogleCloudSTTProvider.js';
