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

/** Whether an IPv4 address, as its four numbers, is this machine or a private network. */
function isPrivateIPv4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, where cloud metadata services answer
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  );
}

/**
 * Whether a URL's host is this machine or a private network: `localhost`,
 * loopback, link-local (the metadata address 169.254.169.254 among them),
 * the private and carrier-grade NAT IPv4 ranges, and their IPv6 forms. The
 * URL parser has already written other IPv4 spellings (`0x7f000001`,
 * `127.1`) as dotted numbers. A public name that resolves to a private
 * address, or redirects to one, is not caught here.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isPrivateIPv4(v4.slice(1).map(Number));
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  // An IPv4-mapped address, as the URL parser writes it (::ffff:7f00:1).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return isPrivateIPv4([high >> 8, high & 255, low >> 8, low & 255]);
  }
  const first = parseInt(host.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // unique local fc00::/7, link-local fe80::/10
}

/**
 * The image source a tool accepts, trimmed: a `data:image/...` URL, or an
 * http(s) URL whose host is not this machine or a private network.
 * Anything else gives `undefined`. AgentOS also reads local file paths and
 * fetches any URL, but a tool the model calls must not send the machine's
 * files, or what its network serves, to an image provider.
 */
export function imageSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const source = value.trim();
  if (/^data:image\//i.test(source)) return source;
  if (!/^https?:\/\//i.test(source)) return undefined;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  return isPrivateHost(url.hostname) ? undefined : source;
}

/** The error for an input that is not an accepted image source. */
export function sourceError(field: string): string {
  return `${field} must be a data:image URL or an http(s) URL on a public host: local file paths are not read, nor local or private network addresses.`;
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
