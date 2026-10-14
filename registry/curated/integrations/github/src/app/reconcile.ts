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
  stringIn,
  type GitHubApiOptions,
} from './http.js';
import { listInstallations } from './installations.js';

/** A repository of a link, with the head of its default branch last read (null when none was read yet). */
export interface ReconcileRepository {
  id: number;
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

/** A repository whose head could not be read, with GitHub's status (for example 404 or 422 once it left the installation). */
export interface UnreadableRepository {
  installationId: number;
  repositoryId: number;
  status: number;
}

/** What the reconcile found and did. */
export interface ReconcileOutcome {
  /** Installations the app no longer has: their links and documents go. */
  gone: number[];
  /** Repositories to compare by tree, as a push to their default branch is. */
  moved: MovedRepository[];
  /** Deliveries asked for again. */
  redelivered: number[];
  /** Repositories whose head GitHub would not answer. */
  unreadable: UnreadableRepository[];
}

/** One attempt at a delivery. */
interface Delivery {
  id: number;
  guid: string;
  deliveredAt: number;
  succeeded: boolean;
}

function deliveryOf(value: unknown): Delivery {
  const fields = objectOf(value, 'a delivery');
  const status = numberIn(fields, 'status_code', 'a delivery');
  return {
    id: numberIn(fields, 'id', 'a delivery'),
    guid: stringIn(fields, 'guid', 'a delivery'),
    deliveredAt: Date.parse(stringIn(fields, 'delivered_at', 'a delivery')),
    succeeded: status >= 200 && status < 300,
  };
}

/**
 * Asks again for each event of the window that no attempt delivered: the newest failed attempt of each delivery guid
 * with no successful attempt since `since`. GitHub lists deliveries newest first, so the pages stop at the first one
 * that reaches past the window.
 */
async function redeliverFailures(credential: GitHubAppCredential, since: number, fetchImpl: typeof fetch, apiBase: string): Promise<number[]> {
  const attemptsByGuid = new Map<string, Delivery[]>();
  for await (const page of githubPages(fetchImpl, `${apiBase}/app/hook/deliveries?per_page=100`, { token: credential.jwt() })) {
    const deliveries = arrayOf(page, 'a page of deliveries').map(deliveryOf);
    for (const delivery of deliveries) {
      if (!(delivery.deliveredAt >= since)) continue;
      const attempts = attemptsByGuid.get(delivery.guid);
      if (attempts === undefined) attemptsByGuid.set(delivery.guid, [delivery]);
      else attempts.push(delivery);
    }
    if (deliveries.length === 0 || deliveries.some((delivery) => !(delivery.deliveredAt >= since))) break;
  }
  const redelivered: number[] = [];
  for (const attempts of attemptsByGuid.values()) {
    if (attempts.some((attempt) => attempt.succeeded)) continue;
    const latest = attempts.reduce((newest, attempt) => (attempt.deliveredAt > newest.deliveredAt ? attempt : newest));
    await discardBody(await githubSend(fetchImpl, `${apiBase}/app/hook/deliveries/${latest.id}/attempts`, { token: credential.jwt(), method: 'POST' }));
    redelivered.push(latest.id);
  }
  return redelivered;
}

/**
 * Reconciles a GitHub App's links with GitHub: an installation that `GET /app/installations` no longer lists is
 * answered gone; each repository of the other links has its default branch's head read with an installation token
 * narrowed to it and is answered moved when the head differs from the one last read, or unreadable with GitHub's
 * status; and the app's failed deliveries since `since` are asked for again
 * (`GET /app/hook/deliveries`, `POST /app/hook/deliveries/{delivery_id}/attempts`).
 *
 * @param credential The app's credential.
 * @param links The links to check.
 * @param options The window's start, and where calls go.
 */
export async function reconcileInstallations(
  credential: GitHubAppCredential,
  links: readonly ReconcileLink[],
  { since, fetchImpl = fetch, apiBase = GITHUB_API_BASE }: ReconcileOptions,
): Promise<ReconcileOutcome> {
  const listed = new Set((await listInstallations(credential, { fetchImpl, apiBase })).map((installation) => installation.id));
  const gone: number[] = [];
  const moved: MovedRepository[] = [];
  const unreadable: UnreadableRepository[] = [];
  for (const link of links) {
    if (!listed.has(link.installationId)) {
      if (!gone.includes(link.installationId)) gone.push(link.installationId);
      continue;
    }
    for (const repository of link.repositories) {
      try {
        const token = await credential.installationToken(link.installationId, [repository.id]);
        const branch = objectOf(
          await githubFetch(fetchImpl, `${apiBase}/repos/${repository.fullName}/branches/${encodeURIComponent(repository.defaultBranch)}`, { token }),
          'a branch',
        );
        const head = stringIn(objectOf(branch.commit, "a branch's commit"), 'sha', "a branch's commit");
        if (head !== repository.headCommit) moved.push({ installationId: link.installationId, repositoryId: repository.id, head });
      } catch (error) {
        if (!(error instanceof GitHubApiError)) throw error;
        unreadable.push({ installationId: link.installationId, repositoryId: repository.id, status: error.status });
      }
    }
  }
  const redelivered = await redeliverFailures(credential, since.getTime(), fetchImpl, apiBase);
  return { gone, moved, redelivered, unreadable };
}
