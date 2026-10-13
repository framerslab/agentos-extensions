import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { classifyJoinUrl } from '../BrowserMeetingProvider.js';
import { PLATFORMS } from '../protocol.js';

/** A platform the browser bot joins. */
export type JoinPlatform = (typeof PLATFORMS)[number];

/** Resolves a host name to every address it answers with. */
export type Resolver = (hostname: string) => Promise<string[]>;

/** The system resolver: every address `getaddrinfo` returns for the host, IPv4 and IPv6. */
export const defaultResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

/**
 * The ranges that are never a meeting host: loopback, private, link-local, carrier-grade NAT, benchmarking, multicast,
 * unspecified, and their IPv4-mapped IPv6 forms. `net.BlockList` matches a subnet whatever the address's spelling
 * (`0:0:0:0:0:0:0:1` is `::1`), which a string prefix test does not.
 */
const PRIVATE = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
  PRIVATE.addSubnet(`::ffff:${net}`, 96 + prefix, 'ipv6');
}
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fe80::', 10], ['fc00::', 7], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, prefix, 'ipv6');

/** Whether an address is outside every range that is never a meeting host; a string that is not an address is not public. */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) return !PRIVATE.check(address, 'ipv4');
  if (v === 6) return !PRIVATE.check(address, 'ipv6');
  return false;
}

/** What {@link checkJoinUrl} decides: the link's platform and whether its host came from the test allowlist, or why it is refused. */
export type JoinUrlCheck = { ok: true; platform: JoinPlatform; testHost: boolean } | { ok: false; message: string };

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * The platform of a join url that is on a platform's own host and resolves to public addresses only.
 *
 * A host in `testHosts` (a test stack's fixture server, from `MEETING_RESOLVE_ALLOW`; empty in production) is taken over
 * `http` or `https` at whatever address it resolves to, and names its platform in its `platform` query parameter, as the
 * fixture page's links do: the run it starts is sent to the fixture adapter.
 */
export async function checkJoinUrl(url: string, resolve: Resolver = defaultResolver, testHosts: readonly string[] = []): Promise<JoinUrlCheck> {
  const parsed = parseUrl(url);
  if (parsed && testHosts.includes(parsed.hostname)) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: 'a test host link must be http or https' };
    const requested = parsed.searchParams.get('platform');
    const platform = PLATFORMS.find((p) => p === requested);
    return platform ? { ok: true, platform, testHost: true } : { ok: false, message: 'a test host link names no platform' };
  }
  const classified = classifyJoinUrl(url);
  if (!classified.ok) return classified;
  const { hostname } = new URL(url);
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    return { ok: false, message: 'the meeting host does not resolve' };
  }
  if (!addresses.length || !addresses.every(isPublicAddress)) return { ok: false, message: 'the meeting host resolves to a private address' };
  return { ok: true, platform: classified.platform as JoinPlatform, testHost: false };
}
