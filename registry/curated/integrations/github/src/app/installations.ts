/**
 * @fileoverview What a user token reaches (the person, the app's installations they can access, and the repositories
 * of an installation they can read) and the app's own installations, listed and removed with its JWT. Each function
 * takes `{ fetchImpl, apiBase, timeoutMs }` last: `fetch`, GitHub's API and a 30-second deadline a call when absent.
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

/** A repository a user token can read in an installation. */
export interface UserRepository {
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
  return pages(fetchImpl, `${apiBase}/user/installations/${installationId}/repositories?per_page=100`, { token, timeoutMs }, (page) =>
    arrayOf(objectOf(page, 'a page of repositories').repositories, 'a page of repositories').map((value) => {
      const repository = objectOf(value, 'a repository');
      return {
        id: numberIn(repository, 'id', 'a repository'),
        fullName: stringIn(repository, 'full_name', 'a repository'),
        defaultBranch: stringIn(repository, 'default_branch', 'a repository'),
      };
    }),
  );
}

/** Every installation of the app (`GET /app/installations`, with its JWT), across every page. */
export async function listInstallations(
  credential: GitHubAppCredential,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<GitHubInstallation[]> {
  return pages(fetchImpl, `${apiBase}/app/installations?per_page=100`, { token: credential.jwt(), timeoutMs }, (page) =>
    arrayOf(page, 'a page of installations').map(installationOf),
  );
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
