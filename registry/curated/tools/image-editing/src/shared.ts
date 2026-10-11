// @ts-nocheck
/**
 * @fileoverview What the three image-editing tools share: the provider keys,
 * the choice of provider, the checks on arguments and image sources, and how
 * the images a provider returns reach the caller.
 */

import * as agentos from '@framers/agentos';

import { imageStore, readSavedImage, scopeOf, storeImage, type ImageStore, type SaveImage } from './imageFiles.js';

export { imageStore, storeImage };
export type { ImageStore, SaveImage };

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
 * 6to4 relay anycast block (192.88.99/24), the documentation and
 * benchmarking ranges, multicast, reserved and broadcast.
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
    (a === 192 && b === 88 && c === 99) ||
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
 * Whether an IPv6 address is off the public internet. Only 2000::/3 is
 * allocated for global unicast, so everything outside it is refused
 * (unspecified, loopback, the deprecated IPv4-compatible form, discard, SRv6,
 * unique local, link-local, site-local, multicast, and space no one has been
 * given), except the two forms that reach an IPv4 address and are judged by
 * it: IPv4-mapped (::ffff:0:0/96) and the NAT64 well-known prefix
 * (64:ff9b::/96). Inside 2000::/3, 6to4 (2002::/16) is judged by the address
 * it carries, and the IETF protocol assignments (2001::/23) and documentation
 * (2001:db8::/32 and 3fff::/20) are refused. The same rule as AgentOS's
 * `isPublicNetworkAddress`.
 */
function isNonPublicIPv6(groups: number[]): boolean {
  const carried = (high: number, low: number) => isNonPublicIPv4([high >> 8, high & 255, low >> 8, low & 255]);
  const [g0, g1, g2, , , g5, g6, g7] = groups;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && g5 === 0xffff) return carried(g6, g7);
  if (g0 === 0x64 && g1 === 0xff9b && zeros(2, 6)) return carried(g6, g7);
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2002) return carried(g1, g2);
  if (g0 === 0x2001 && (g1 <= 0x01ff || g1 === 0xdb8)) return true;
  return g0 === 0x3fff && g1 <= 0x0fff;
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

/** An image input a tool accepts, by where the image is. */
export type ImageSource =
  | { kind: 'data'; value: string }
  | { kind: 'http'; value: string }
  | { kind: 'file'; value: string };

/**
 * The image source a tool accepts: a `data:image/...` URL, an http(s) URL
 * whose host is not this machine or a private network, or a `file:` URL,
 * which {@link loadImage} then holds to the images this tool saved. Anything
 * else gives `undefined`. AgentOS also reads any local file path and fetches
 * any URL, but a tool the model calls must not send the machine's files, or
 * what its network serves, to an image provider.
 *
 * The value is written in one way whatever the model wrote: the scheme in
 * lower case, and for an http(s) URL the parser's own serialization, with
 * its dot segments resolved.
 */
export function imageSource(value: unknown): ImageSource | undefined {
  if (typeof value !== 'string') return undefined;
  const source = value.trim();
  if (/^data:image\//i.test(source)) return { kind: 'data', value: `data:${source.slice(5)}` };
  if (/^file:/i.test(source)) return { kind: 'file', value: source };
  if (!/^https?:\/\//i.test(source)) return undefined;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  return isPrivateHost(url.hostname) ? undefined : { kind: 'http', value: url.href };
}

/** The error for an input that is not an accepted image source. */
export function sourceError(field: string): string {
  return `${field} must be a data:image URL, an http(s) URL on a public host, or the file: URL of an image this tool saved: other local files are not read, nor local or private network addresses.`;
}

/**
 * The bytes of an image source, for AgentOS.
 *
 * A `file:` URL must name an image the default saver wrote for this caller.
 * A data URL and an http(s) URL go through AgentOS's `imageToBuffer` with
 * `untrusted: true`: the fetch connects only to public network addresses
 * (every address the host resolves to, and every redirect, is checked), and
 * the image is held to 50 MiB and 30 seconds. An AgentOS without that mode
 * (it has no `isPublicNetworkAddress` export; the mode came in 0.13.16)
 * would fetch the URL unchecked, so an http(s) source is refused there.
 *
 * @throws With the tool's refusal for a `file:` URL that is not such an
 *   image, with a message that names the AgentOS release for an http(s)
 *   source on an older one, and with AgentOS's own error for a refused or
 *   failed fetch.
 */
export async function loadImage(
  source: ImageSource,
  field: string,
  store: ImageStore,
  context?: unknown,
): Promise<Buffer> {
  if (source.kind === 'file') {
    const bytes = await readSavedImage(source.value, store.dir, scopeOf(context));
    if (!bytes) throw new Error(sourceError(field));
    return bytes;
  }
  if (source.kind === 'http' && typeof agentos.isPublicNetworkAddress !== 'function') {
    throw new Error(
      `${field} is an http(s) URL, which needs @framers/agentos 0.13.16 or later: pass a data:image URL, or update AgentOS.`,
    );
  }
  return agentos.imageToBuffer(source.value, { untrusted: true });
}

/**
 * The error for a model id that carries another provider's prefix, or
 * `undefined`. AgentOS lets a `provider:` prefix in the model id win over
 * `provider`, so `model: 'replicate:owner/name'` on a call that holds the
 * OpenAI key would send that key to Replicate. Any `word:` prefix that is
 * not the provider in use is refused; none of the three providers' own ids
 * starts with one (a Replicate version follows `owner/name`).
 */
export function foreignModelPrefix(model: string | undefined, provider: string | undefined): string | undefined {
  if (!model || !provider) return undefined;
  const prefix = /^([a-z0-9][a-z0-9-]*):/i.exec(model)?.[1].toLowerCase();
  return prefix && prefix !== provider
    ? `model names the provider "${prefix}", but this call uses ${provider}: give the model's own id.`
    : undefined;
}

/** A finite number given as a number or as a numeric string; `undefined` for anything else. */
export function numberOf(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

/**
 * An optional string argument, trimmed: `{ value }` when it is absent or a
 * string (an empty one counts as absent), `{ error }` when it is anything
 * else.
 */
export function optionalString(value: unknown, field: string): { value?: string; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') return { error: `${field} must be a string.` };
  return { value: value.trim() || undefined };
}

/** The message of a thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
