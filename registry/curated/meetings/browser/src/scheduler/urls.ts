import { lookup } from 'node:dns/promises';
import { isPublicNetworkAddress } from '@framers/agentos/io/media/images';
import { classifyJoinUrl } from '../BrowserMeetingProvider.js';
import { PLATFORMS } from '../protocol.js';

/** A platform the browser bot joins. */
export type JoinPlatform = (typeof PLATFORMS)[number];

/** Resolves a host name to every address it answers with. */
export type Resolver = (hostname: string) => Promise<string[]>;

/** The system resolver: every address `getaddrinfo` returns for the host, IPv4 and IPv6. */
export const defaultResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address);

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
 * The platform of a join url that is on a platform's own host and resolves to public addresses only. Every address the
 * host answers with must pass AgentOS's `isPublicNetworkAddress`, the rule its guarded fetches apply: loopback,
 * private, link-local, carrier-grade NAT, documentation, benchmarking, multicast, reserved and unallocated ranges are
 * refused, and so is an IPv6 address that carries a refused IPv4 one (IPv4-mapped, NAT64, 6to4), whatever its spelling.
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
  if (!addresses.length || !addresses.every((address) => isPublicNetworkAddress(address))) return { ok: false, message: 'the meeting host resolves to a private address' };
  return { ok: true, platform: classified.platform as JoinPlatform, testHost: false };
}
