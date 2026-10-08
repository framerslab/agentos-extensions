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
): { provider?: ImageEditingProvider; apiKey?: string; error?: string } {
  if (requested && requested !== 'auto') {
    // The model can send a value the input schema does not allow.
    if (!supported.includes(requested as ImageEditingProvider)) {
      return { error: `provider must be one of ${supported.join(', ')} or auto.` };
    }
    const provider = requested as ImageEditingProvider;
    return { provider, apiKey: keys[provider] };
  }
  const provider = supported.find((name) => keys[name]);
  return provider ? { provider, apiKey: keys[provider] } : {};
}

/**
 * Whether an IPv4 address, as its four numbers, is off the public internet:
 * "this network", private, carrier-grade NAT, loopback, link-local (cloud
 * metadata services answer at 169.254.169.254), the IETF protocol block, the
 * documentation and benchmarking ranges, multicast, reserved and broadcast.
 */
function isNonPublicIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** The eight 16-bit groups of an IPv6 address, or `undefined` when the text is not one. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  // A trailing dotted IPv4 (::ffff:1.2.3.4) is two groups.
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [w, x, y, z] = dotted.slice(2).map(Number);
    if ([w, x, y, z].some((n) => n > 255)) return undefined;
    text = `${dotted[1]}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return undefined;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * Whether an IPv6 address is off the public internet, the IPv4 address it
 * carries included: unspecified, loopback, IPv4-compatible and IPv4-mapped,
 * NAT64 (64:ff9b::/96 and 64:ff9b:1::/48), 6to4 (2002::/16), discard
 * (100::/64), documentation (2001:db8::/32), unique local, link-local,
 * site-local and multicast.
 */
function isNonPublicIPv6(groups: number[]): boolean {
  const carried = (high: number, low: number) => isNonPublicIPv4([high >> 8, high & 255, low >> 8, low & 255]);
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zeros(0, 6)) return (g6 === 0 && g7 <= 1) || carried(g6, g7);
  if (zeros(0, 5) && g5 === 0xffff) return carried(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b) return g2 === 1 || !zeros(2, 6) || carried(g6, g7);
  if (g0 === 0x2002) return carried(g1, g2);
  if (g0 === 0x100 && zeros(1, 4)) return true;
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
}

/**
 * Whether a URL's host is this machine or off the public internet: `localhost`
 * names, and the IPv4 and IPv6 literals above. The URL parser has already
 * written other IPv4 spellings (`0x7f000001`, `127.1`) as dotted numbers. An
 * IPv6 literal that cannot be read is treated as not public. The check reads
 * the host as written: the address a name resolves to, and the target of a
 * redirect, are not checked here.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isNonPublicIPv4(v4.slice(1).map(Number));
  if (!host.includes(':')) return false;
  const groups = ipv6Groups(host);
  return groups === undefined || isNonPublicIPv6(groups);
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
