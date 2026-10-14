import type { BrowserContext, Request } from 'playwright';
import type { PlatformAdapter } from './adapters/types.js';

/** An address literal as a URL's host shows it: dotted IPv4, or IPv6 in brackets (the URL parser writes every other IPv4 spelling as dotted). */
export const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f:]+\]?)$/i;

/** Whether a host is one of the patterns: an exact host, or `*.suffix` for the suffix itself and every host under it. */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.startsWith('*.') ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p));
}

/** What the policy reads of one request. */
export interface RequestFacts {
  /** The request's url. */
  url: string;
  /** Whether it loads the page's top-level document: a link opened, a redirect, a navigation of the page itself. */
  topLevelNavigation: boolean;
}

/** The policy's answer for one request, with the host it was made to (counted when blocked). */
export interface RequestDecision {
  /** Whether the request goes ahead. */
  allowed: boolean;
  /** The request's host, lower case. */
  host: string;
}

/**
 * The browser's own boundary, inside the container: https only (and plain http for the test fixture alone), no address
 * literal as a host, the top-level document on the platform's join hosts alone (a redirect off them fails the
 * navigation, which the adapter reports), and every other request, a frame's document included, on the platform's hosts.
 */
export function requestAllowed(facts: RequestFacts, adapter: Pick<PlatformAdapter, 'joinHosts' | 'allowedHosts' | 'allowHttp'>): RequestDecision {
  let url: URL;
  try {
    url = new URL(facts.url);
  } catch {
    return { allowed: false, host: 'unparsable' };
  }
  const host = url.hostname.toLowerCase();
  const scheme = url.protocol === 'https:' || (adapter.allowHttp === true && url.protocol === 'http:');
  const hosts = facts.topLevelNavigation ? adapter.joinHosts : adapter.allowedHosts;
  return { allowed: scheme && !IP_LITERAL.test(host) && hostAllowed(host, hosts), host };
}

/** Whether a request loads the top-level document; a navigation made before its frame exists (a new window) counts as one. */
function topLevelNavigation(request: Request): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return true;
  }
}

/**
 * Puts {@link requestAllowed} on every request the browser's pages make. What is blocked is counted by host and
 * reported at the end, never fetched. Playwright's route sees HTTP and HTTPS requests; the WebSocket and media
 * connections the clients make are the worker's firewall's (the ports, the private-range drops), and the scheduler
 * refused a join host that resolves to a private address before the container started. The bot launches the browser
 * with service workers blocked, since a service worker's own requests pass the route by.
 */
export async function installNetworkPolicy(context: BrowserContext, adapter: PlatformAdapter, blocked: Map<string, number>): Promise<void> {
  await context.route('**/*', (route) => {
    const request = route.request();
    const decision = requestAllowed({ url: request.url(), topLevelNavigation: topLevelNavigation(request) }, adapter);
    // a route the closing browser has already let go answers neither call; the policy has nothing left to decide for it
    if (decision.allowed) return route.continue().catch(() => undefined);
    blocked.set(decision.host, (blocked.get(decision.host) ?? 0) + 1);
    return route.abort('blockedbyclient').catch(() => undefined);
  });
}
