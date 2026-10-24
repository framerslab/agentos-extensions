/**
 * @fileoverview What a user token reaches (the person, the app's installations they can access, and the repositories
 * of an installation they can read), the app's own installations, listed, read one at a time and removed with its JWT,
 * each with when it was suspended, and the repositories an installation reaches, listed with an installation token, and
 * those of them a caller holds that it no longer reaches. Each function takes `{ fetchImpl, apiBase, timeoutMs }` last:
 * `fetch`, GitHub's API and a 30-second deadline a call when absent.
 * @module agentos-ext-github/app/installations
 */

import type { GitHubAppCredential } from './credential.js';
import {
  arrayOf,
  discardBody,
  GITHUB_API_BASE,
  GitHubApiError,
  githubFetch,
  githubSend,
  numberIn,
  objectOf,
  pages,
  stringIn,
  type GitHubApiOptions,
} from './http.js';

/** The person a user token belongs to. */
export interface GitHubUser {
  id: number;
  login: string;
}

/** The account an installation is on: a user's or an organization's login, or an enterprise's slug. */
export interface GitHubAccount {
  login: string;
  id: number;
}

/** One installation of the app; GitHub may answer it without an account. */
export interface GitHubInstallation {
  id: number;
  account: GitHubAccount | null;
}

/** One installation as the app's own calls answer it (`listInstallations`, `getInstallation`): with when it was suspended. */
export interface AppInstallation extends GitHubInstallation {
  /**
   * When the installation was suspended (GitHub's `suspended_at`, an ISO 8601 time), or null while it is not. GitHub
   * blocks a suspended installation's access to the API and its webhook events until it is unsuspended.
   */
  suspendedAt: string | null;
}

/** A repository a user token can read in an installation. */
export interface UserRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
}

/** A repository an installation reaches, as its own listing answers it. */
export interface InstallationRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
}

/** An installation's account, as GitHub answers it and as a webhook event names it: a login, or an enterprise's slug, and an id. */
export function accountOf(value: unknown): GitHubAccount {
  const account = objectOf(value, "an installation's account");
  return {
    login: stringIn(account, typeof account.login === 'string' ? 'login' : 'slug', "an installation's account"),
    id: numberIn(account, 'id', "an installation's account"),
  };
}

function installationOf(value: unknown): GitHubInstallation {
  const fields = objectOf(value, 'an installation');
  return {
    id: numberIn(fields, 'id', 'an installation'),
    account: fields.account === null || fields.account === undefined ? null : accountOf(fields.account),
  };
}

/** An installation as the app's own calls answer it: `suspended_at` a time, or null when GitHub sends none. */
function appInstallationOf(value: unknown): AppInstallation {
  const fields = objectOf(value, 'an installation');
  return { ...installationOf(fields), suspendedAt: typeof fields.suspended_at === 'string' ? fields.suspended_at : null };
}

/** The repositories of a page of a repository listing: each one's id, full name and default branch. */
function repositoriesOfPage(page: unknown): { id: number; fullName: string; defaultBranch: string }[] {
  return arrayOf(objectOf(page, 'a page of repositories').repositories, 'a page of repositories').map((value) => {
    const repository = objectOf(value, 'a repository');
    return {
      id: numberIn(repository, 'id', 'a repository'),
      fullName: stringIn(repository, 'full_name', 'a repository'),
      defaultBranch: stringIn(repository, 'default_branch', 'a repository'),
    };
  });
}

/** The person a user token belongs to (`GET /user`): the GitHub id and login a link is made by. */
export async function userOfToken(token: string, { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {}): Promise<GitHubUser> {
  const user = objectOf(await githubFetch(fetchImpl, `${apiBase}/user`, { token, timeoutMs }), 'a user');
  return { id: numberIn(user, 'id', 'a user'), login: stringIn(user, 'login', 'a user') };
}

/** The app's installations a user token can access (`GET /user/installations`), across every page. */
export async function installationsOfUser(
  token: string,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<GitHubInstallation[]> {
  return pages(fetchImpl, `${apiBase}/user/installations?per_page=100`, { token, timeoutMs }, (page) =>
    arrayOf(objectOf(page, 'a page of installations').installations, 'a page of installations').map(installationOf),
  );
}

/**
 * The repositories of an installation a user token can read (`GET /user/installations/{installation_id}/repositories`),
 * across every page: those the person owns, collaborates on or reaches through an organization.
 */
export async function repositoriesOfUser(
  token: string,
  installationId: number,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<UserRepository[]> {
  return pages(fetchImpl, `${apiBase}/user/installations/${installationId}/repositories?per_page=100`, { token, timeoutMs }, repositoriesOfPage);
}

/**
 * Every repository an installation reaches (`GET /installation/repositories`), across every page, read with an
 * installation token that reads their metadata and nothing else (`credential.metadataToken`): the whole of what the
 * app may read through the installation, whoever asks, so a repository its owner took off the app since a link was
 * made is missing from it. The token is minted with the credential's own fetch; the pages are read with `fetchImpl`. A
 * held token GitHub refuses (401, as it refuses every token of an installation it no longer has) is dropped and one
 * new token asked for, once. A refused token request throws `GitHubApiError` (404 for an installation GitHub no longer
 * has), so a lost installation never reads as one that reaches no repository. The listing is read a page at a time, so
 * a repository added to or taken off the installation while it is read can move another one past a page's end, and
 * that one is missing from the answer: {@link repositoriesLost} reads it twice before it answers a repository lost.
 */
export async function repositoriesOfInstallation(
  credential: GitHubAppCredential,
  installationId: number,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<InstallationRepository[]> {
  const url = `${apiBase}/installation/repositories?per_page=100`;
  try {
    return await pages(fetchImpl, url, { token: await credential.metadataToken(installationId, { timeoutMs }), timeoutMs }, repositoriesOfPage);
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 401) throw error;
    credential.forget(installationId);
    return pages(fetchImpl, url, { token: await credential.metadataToken(installationId, { timeoutMs }), timeoutMs }, repositoriesOfPage);
  }
}

/**
 * Which of the repositories `held` an installation no longer reaches: those missing from its listing
 * (`repositoriesOfInstallation`) read twice, the second listing read only when the first misses one. A repository added
 * to or taken off the installation while a listing is read can move another one past a page's end, so a repository
 * missing from one listing alone is not answered lost; one missing from both is. Answers in the order of `held`, each
 * id once, and makes no request for an empty `held`. A refused listing throws as `repositoriesOfInstallation` does,
 * so a failure never answers a repository lost.
 *
 * @param credential The app's credential, whose metadata token the listings are read with.
 * @param installationId The installation.
 * @param held The repositories the caller holds for the installation.
 * @param options Where calls go.
 */
export async function repositoriesLost(
  credential: GitHubAppCredential,
  installationId: number,
  held: readonly number[],
  options: GitHubApiOptions = {},
): Promise<number[]> {
  const missingFrom = (listed: readonly InstallationRepository[], among: readonly number[]): number[] => {
    const reached = new Set(listed.map((repository) => repository.id));
    return among.filter((id) => !reached.has(id));
  };
  const asked = [...new Set(held)];
  if (asked.length === 0) return [];
  const first = missingFrom(await repositoriesOfInstallation(credential, installationId, options), asked);
  if (first.length === 0) return [];
  return missingFrom(await repositoriesOfInstallation(credential, installationId, options), first);
}

/**
 * Every installation of the app (`GET /app/installations`, with its JWT), across every page, each with when GitHub
 * suspended it. The listing is read a page at a time, so an installation removed while it is read can move another one
 * past a page's end, and that one is missing from the answer: `reconcileInstallations` asks for each linked
 * installation it misses by its own address (`getInstallation`) before it answers one gone.
 */
export async function listInstallations(
  credential: GitHubAppCredential,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<AppInstallation[]> {
  return pages(fetchImpl, `${apiBase}/app/installations?per_page=100`, { token: credential.jwt(), timeoutMs }, (page) =>
    arrayOf(page, 'a page of installations').map(appInstallationOf),
  );
}

/**
 * One installation of the app (`GET /app/installations/{installation_id}`, with its JWT), with when GitHub suspended
 * it, or null when GitHub no longer has it (404). Any other refusal throws {@link GitHubApiError}, and a call that gets
 * no answer throws `GitHubNoAnswer`, so an installation is never answered gone on a failure.
 *
 * @param credential The app's credential.
 * @param installationId The installation.
 * @param options Where calls go.
 */
export async function getInstallation(
  credential: GitHubAppCredential,
  installationId: number,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<AppInstallation | null> {
  try {
    return appInstallationOf(await githubFetch(fetchImpl, `${apiBase}/app/installations/${installationId}`, { token: credential.jwt(), timeoutMs }));
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Uninstalls the app from an account (`DELETE /app/installations/{installation_id}`, with its JWT). Answers without an
 * error on a 2xx (202 at the pinned API version, where GitHub has taken the removal and does it in the background; 204
 * at earlier versions) and on 404 (the installation is already gone); the answer's body is never read, and is released
 * without waiting on its cancel. Any other status throws {@link GitHubApiError}.
 */
export async function uninstallInstallation(
  credential: GitHubAppCredential,
  installationId: number,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<void> {
  try {
    const answer = await githubSend(fetchImpl, `${apiBase}/app/installations/${installationId}`, { token: credential.jwt(), method: 'DELETE', timeoutMs });
    discardBody(answer.response);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return;
    throw error;
  }
}
