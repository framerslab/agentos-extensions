// @ts-nocheck
/**
 * @fileoverview What the three image-editing tools share: the provider keys,
 * the choice of provider, the check on image sources and the shape of the
 * images they return.
 */

/** An image as AgentOS's image functions return it. */
export interface GeneratedImage {
  url?: string;
  dataUrl?: string;
  base64?: string;
  mimeType?: string;
}

/** The providers these tools route to by name. */
export type ImageEditingProvider = 'openai' | 'stability' | 'replicate';

/** API keys by provider, from the pack's secrets or the environment. */
export type ProviderKeys = Partial<Record<ImageEditingProvider, string>>;

/**
 * The provider for a call: the one named, or with `auto` (or none) the first
 * of `supported` that has a key. When none has a key the result is
 * `undefined`, and AgentOS picks a provider from the environment.
 */
export function chooseProvider(
  requested: string | undefined,
  supported: ImageEditingProvider[],
  keys: ProviderKeys,
): { provider?: ImageEditingProvider; apiKey?: string } {
  if (requested && requested !== 'auto') {
    const provider = requested as ImageEditingProvider;
    return { provider, apiKey: keys[provider] };
  }
  const provider = supported.find((name) => keys[name]);
  return provider ? { provider, apiKey: keys[provider] } : {};
}

/**
 * An image the tools accept: an http(s) URL or a `data:image/...` URL.
 * AgentOS also reads local file paths, but a tool the model calls must not
 * read the machine's files and send them to an image provider.
 */
export function isImageSource(value: unknown): value is string {
  return typeof value === 'string' && /^(https?:\/\/|data:image\/)/i.test(value.trim());
}

/** The error for an input that is not an accepted image source. */
export function sourceError(field: string): string {
  return `${field} must be an http(s) URL or a data:image URL; local file paths are not read.`;
}

/**
 * An image as a link the caller can use: the provider's URL, else a data URL
 * built from the image data.
 */
export function imageLink(image: GeneratedImage | undefined): string | undefined {
  if (!image) return undefined;
  if (image.url) return image.url;
  if (image.dataUrl) return image.dataUrl;
  if (image.base64) return `data:${image.mimeType || 'image/png'};base64,${image.base64}`;
  return undefined;
}

/** The message of a thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
