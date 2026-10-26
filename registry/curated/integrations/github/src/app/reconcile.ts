/**
 * @fileoverview The daily reconcile of a GitHub App's links, for what its webhook deliveries missed: deliveries are lost
 * while a server is down, and GitHub does not deliver a failed one again by itself.
 * @module agentos-ext-github/app/reconcile
 */

import type { GitHubAppCredential } from './credential.js';
import {
  arrayOf,
  discardBody,
  GITHUB_API_BASE,
  GitHubApiError,
  githubFetch,
  githubPages,
  githubSend,
  numberIn,
  objectOf,
  repositoryPath,
  stringIn,
  type GitHubApiOptions,
} from './http.js';
import { getInstallation, listInstallations, type AppInstallation } from './installations.js';

/** A repository of a link, with the head of its default branch last read (null when none was read yet). */
export interface ReconcileRepository {
  /** The repository's id: its head is read by it. */
  id: number;
  /** `owner/name`, kept for the caller's records; the reconcile never reads the repository by it. */
  fullName: string;
  defaultBranch: string;
  headCommit: string | null;
}

/** A link: an installation and the repositories read through it. */
export interface ReconcileLink {
  installationId: number;
  repositories: readonly ReconcileRepository[];
}

/** The window of deliveries to look at, and where calls go. */
export interface ReconcileOptions extends GitHubApiOptions {
  /** The start of the window: failed deliveries since then are asked for again. */
  since: Date;
}

/** A repository whose default branch moved past the head last read. */
export interface MovedRepository {
  installationId: number;
  repositoryId: number;
  /** The head to read. */
  head: string;
}

/**
 * A repository whose head GitHub would not answer, with its status (for example 404 or 422 once it left the
 * installation). A refusal for a rate limit is never one: it ends the reconcile (`retryAt`).
 */
export interface UnreadableRepository {
  installationId: number;
  repositoryId: number;
  status: number;
}

/** A redelivery GitHub refused: the delivery asked for again, and GitHub's status. */
export interface RefusedRedelivery {
  id: number;
  status: number;
}

/** How the deliveries step went, beside the deliveries it asked for again. */
export interface DeliveriesOutcome {
  /**
   * GitHub's status when it answered the deliveries listing outside 2xx, in which case no delivery was asked for
   * again; null when the listing was read, or when a rate limit ended the reconcile before the deliveries step.
   */
  listingStatus: number | null;
  /**
   * Redeliveries GitHub refused. After any other refusal the rest are still asked for; after one for a rate limit,
   * none is (`retryAt`).
   */
  refused: RefusedRedelivery[];
}

/** What the reconcile found and did. */
export interface ReconcileOutcome {
  /**
   * Installations the app no longer has: their links and documents go. Each one missing from the installations listing
   * is asked for by its own address, and answered gone only when GitHub answers that 404.
   */
  gone: number[];
  /**
   * The linked installations GitHub has suspended, each once, in the order of the links: none of their repositories is
   * read, since GitHub blocks a suspended installation's access to the API, and a linked installation not here nor in
   * `gone` is not suspended, whatever a missed `suspend` or `unsuspend` delivery would have said.
   */
  suspended: number[];
  /** Repositories to compare by tree, as a push to their default branch is. */
  moved: MovedRepository[];
  /** Deliveries asked for again. */
  redelivered: number[];
  /** Repositories whose head GitHub would not answer. */
  unreadable: UnreadableRepository[];
  /** GitHub's refusals in the deliveries step, which never cost the lists above. */
  deliveries: DeliveriesOutcome;
  /**
   * Epoch milliseconds before which the reconcile is not run again, set when GitHub refused one of its calls for a rate
   * limit; null otherwise. The reconcile makes no call after that refusal, so the repositories and deliveries it had
   * not reached are left for its next run, and the lists above hold what it found before the refusal.
   */
  retryAt: number | null;
}

/** Epoch milliseconds before which a call is not made again after GitHub refused it for a rate limit. */
function rateLimitEnd(error: GitHubApiError): number {
  // A rate limit always carries its time; a minute on, GitHub's own floor, should one ever come without it.
  return error.retryAt ?? Date.now() + 60_000;
}

/** One attempt at a delivery, with the status the receiving route answered. */
interface Delivery {
  id: number;
  guid: string;
  deliveredAt: number;
  statusCode: number;
}

/** The client refusals a retry may change: a timeout (408) and a rate limit (429). */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

function deliveryOf(value: unknown): Delivery {
  const fields = objectOf(value, 'a delivery');
  return {
    id: numberIn(fields, 'id', 'a delivery'),
    guid: stringIn(fields, 'guid', 'a delivery'),
    deliveredAt: Date.parse(stringIn(fields, 'delivered_at', 'a delivery')),
    statusCode: numberIn(fields, 'status_code', 'a delivery'),
  };
}

/** True when the route took the attempt (a 2xx). */
function delivered(attempt: Delivery): boolean {
  return attempt.statusCode >= 200 && attempt.statusCode < 300;
}

/** True when the route refused the attempt with a 4xx a retry would not change: any but 408 and 429. */
function refusedByRoute(attempt: Delivery): boolean {
  return attempt.statusCode >= 400 && attempt.statusCode < 500 && !TRANSIENT_CLIENT_STATUSES.has(attempt.statusCode);
}

/**
 * Asks again for each event of the window that no attempt delivered: the newest failed attempt of each delivery guid
 * with no successful attempt since `since`, unless the route refused that newest attempt with a 4xx other than 408 and
 * 429. GitHub lists deliveries newest first, so the pages stop at the first one that reaches past the window. A
 * listing GitHub answers outside 2xx asks for nothing again and answers GitHub's status, since a guid's other attempts
 * may lie on the pages not read; a redelivery GitHub refuses is answered with its status, and the others are still
 * asked for, unless GitHub refused it for a rate limit: then no call follows, and `retryAt` says when to call again.
 */
async function redeliverFailures(
  credential: GitHubAppCredential,
  since: number,
  fetchImpl: typeof fetch,
  apiBase: string,
  timeoutMs: number | undefined,
): Promise<{ redelivered: number[]; deliveries: DeliveriesOutcome; retryAt: number | null }> {
  const attemptsByGuid = new Map<string, Delivery[]>();
  try {
    for await (const page of githubPages(fetchImpl, `${apiBase}/app/hook/deliveries?per_page=100`, { token: credential.jwt(), timeoutMs })) {
      const deliveries = arrayOf(page, 'a page of deliveries').map(deliveryOf);
      for (const delivery of deliveries) {
        if (!(delivery.deliveredAt >= since)) continue;
        const attempts = attemptsByGuid.get(delivery.guid);
        if (attempts === undefined) attemptsByGuid.set(delivery.guid, [delivery]);
        else attempts.push(delivery);
      }
      if (deliveries.length === 0 || deliveries.some((delivery) => !(delivery.deliveredAt >= since))) break;
    }
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    return { redelivered: [], deliveries: { listingStatus: error.status, refused: [] }, retryAt: error.rateLimited ? rateLimitEnd(error) : null };
  }
  const redelivered: number[] = [];
  const refused: RefusedRedelivery[] = [];
  for (const attempts of attemptsByGuid.values()) {
    if (attempts.some(delivered)) continue;
    const latest = attempts.reduce((newest, attempt) => (attempt.deliveredAt > newest.deliveredAt ? attempt : newest));
    if (refusedByRoute(latest)) continue;
    try {
      const answer = await githubSend(fetchImpl, `${apiBase}/app/hook/deliveries/${latest.id}/attempts`, { token: credential.jwt(), method: 'POST', timeoutMs });
      discardBody(answer.response);
      redelivered.push(latest.id);
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      refused.push({ id: latest.id, status: error.status });
      if (error.rateLimited) return { redelivered, deliveries: { listingStatus: null, refused }, retryAt: rateLimitEnd(error) };
    }
  }
  return { redelivered, deliveries: { listingStatus: null, refused }, retryAt: null };
}

/**
 * Reconciles a GitHub App's links with GitHub: an installation that `GET /app/installations` no longer lists is asked
 * for by its own address (`GET /app/installations/{installation_id}`, since the listing is read a page at a time and an
 * installation removed meanwhile can move another past a page's end) and answered gone when GitHub answers that 404; an
 * installation GitHub has suspended is answered suspended, its repositories not read; each repository of the other
 * links has its default branch's head read by the repository's id
 * (`/repositories/<id>/branches/<branch>`, never by its name, which can come to mean another repository) with an
 * installation token narrowed to it, and is answered moved when the head differs from the one last read, or unreadable
 * with GitHub's status; and the app's failed deliveries since `since` are asked for again
 * (`GET /app/hook/deliveries`, `POST /app/hook/deliveries/{delivery_id}/attempts`). `timeoutMs` bounds every call,
 * the installation token requests among them.
 *
 * A delivery whose newest attempt the receiving route answered with a 4xx other than 408 and 429 is not asked for
 * again: such a refusal (a body past the route's size cap, a 413) answers the same on every attempt, and each new
 * attempt would bring the delivery into the next run's window again, while a 408 or a 429 is a transient the route
 * itself asks to be sent again. GitHub's refusals in the deliveries step never cost the lists computed before it: a
 * deliveries listing GitHub answers outside 2xx is answered as `deliveries.listingStatus`, with no delivery asked for
 * again, and a redelivery it refuses as an entry of `deliveries.refused`, the others still asked for.
 *
 * A call GitHub refuses for a rate limit ends the reconcile: no call follows it (GitHub may ban an integration that
 * keeps calling while it is rate limited), `retryAt` says when to run it again, and the outcome holds what was found
 * before the refusal. The gone and the suspended installations are always whole, since they are settled before any
 * head is read; a repository whose head read was refused for a rate limit is not unreadable, and the repositories after
 * it and the deliveries step wait for the next run. A rate limit on `GET /app/installations` itself, or on an
 * installation's own address, throws `GitHubApiError` with its `retryAt`, as any other refusal of those calls does
 * (an installation's own address answering 404 apart), before anything is found.
 *
 * @param credential The app's credential.
 * @param links The links to check.
 * @param options The window's start, and where calls go.
 */
export async function reconcileInstallations(
  credential: GitHubAppCredential,
  links: readonly ReconcileLink[],
  { since, fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: ReconcileOptions,
): Promise<ReconcileOutcome> {
  const listed = new Map<number, AppInstallation>(
    (await listInstallations(credential, { fetchImpl, apiBase, timeoutMs })).map((installation): [number, AppInstallation] => [installation.id, installation]),
  );
  const gone: number[] = [];
  const suspended: number[] = [];
  const settled = new Set<number>();
  for (const link of links) {
    const installationId = link.installationId;
    if (settled.has(installationId)) continue;
    settled.add(installationId);
    let installation = listed.get(installationId);
    if (installation === undefined) {
      // Missing from a listing read a page at a time is not gone: an installation removed meanwhile moves another past
      // a page's end. GitHub's 404 at the installation's own address is.
      const found = await getInstallation(credential, installationId, { fetchImpl, apiBase, timeoutMs });
      if (found === null) {
        gone.push(installationId);
        continue;
      }
      installation = found;
    }
    if (installation.suspendedAt !== null) suspended.push(installationId);
  }
  const moved: MovedRepository[] = [];
  const unreadable: UnreadableRepository[] = [];
  for (const link of links) {
    if (gone.includes(link.installationId) || suspended.includes(link.installationId)) continue;
    for (const repository of link.repositories) {
      try {
        const token = await credential.installationToken(link.installationId, [repository.id], { timeoutMs });
        const address = `${apiBase}/${repositoryPath(repository.id)}/branches/${encodeURIComponent(repository.defaultBranch)}`;
        const branch = objectOf(await githubFetch(fetchImpl, address, { token, timeoutMs }), 'a branch');
        const head = stringIn(objectOf(branch.commit, "a branch's commit"), 'sha', "a branch's commit");
        if (head !== repository.headCommit) moved.push({ installationId: link.installationId, repositoryId: repository.id, head });
      } catch (error) {
        if (!(error instanceof GitHubApiError)) throw error;
        if (error.rateLimited) {
          return { gone, suspended, moved, redelivered: [], unreadable, deliveries: { listingStatus: null, refused: [] }, retryAt: rateLimitEnd(error) };
        }
        unreadable.push({ installationId: link.installationId, repositoryId: repository.id, status: error.status });
      }
    }
  }
  const { redelivered, deliveries, retryAt } = await redeliverFailures(credential, since.getTime(), fetchImpl, apiBase, timeoutMs);
  return { gone, suspended, moved, redelivered, unreadable, deliveries, retryAt };
}
