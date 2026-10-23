/**
 * @fileoverview A GitHub App's credential: the app's JWT, signed RS256 from its private key, and installation tokens
 * minted with it, narrowed to the repositories asked for, or to the metadata of every repository of the installation,
 * and held in memory until near their end.
 * @module agentos-ext-github/app/credential
 */

import { createSign } from 'node:crypto';
import { GITHUB_API_BASE, githubFetch, objectOf, stringIn } from './http.js';

/** The app's identity: its client id (the JWT's issuer) and its private key in PEM. */
export interface GitHubAppIdentity {
  clientId: string;
  privateKey: string;
}

/** How a token request ends: the caller's signal, and its deadline. */
export interface InstallationTokenOptions {
  /** The caller's signal: the request ends with `GitHubNoAnswer` (`cancelled`) when it aborts. */
  signal?: AbortSignal;
  /** How long the request may take, its answer included; `GITHUB_TIMEOUT_MS` (30 seconds) when absent. */
  timeoutMs?: number;
}

/** How long before its end a held installation token is minted again. */
const RENEW_BEFORE_MS = 300_000;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/**
 * The app's JWT: RS256, issued 60 seconds back against clock drift, valid nine minutes (GitHub takes at most ten),
 * with the client id as its issuer.
 *
 * @param identity The app's client id and private key.
 * @param nowSeconds The time to issue it at, in Unix seconds; now when absent.
 */
export function appJwt(identity: GitHubAppIdentity, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: identity.clientId }));
  const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(identity.privateKey);
  return `${head}.${body}.${base64url(signature)}`;
}

/**
 * Installation tokens, minted narrowed to the repositories asked for, or to the metadata of every repository of the
 * installation, and held in memory until near their end.
 */
export class GitHubAppCredential {
  private readonly held = new Map<string, { token: string; expiresAt: number }>();

  /**
   * @param identity The app's client id and private key.
   * @param fetchImpl The fetch the tokens are minted with.
   * @param apiBase GitHub's REST API, or a stand-in's address in tests.
   */
  constructor(private readonly identity: GitHubAppIdentity, private readonly fetchImpl: typeof fetch = fetch, private readonly apiBase = GITHUB_API_BASE) {}

  /** A fresh JWT for the app's own calls. */
  jwt(): string {
    return appJwt(this.identity);
  }

  /**
   * An installation token that reads only the repositories asked for, held until five minutes before it ends, so a
   * second call within that time makes no request. GitHub's tokens last an hour. A refusal throws `GitHubApiError`
   * (404 for an installation GitHub no longer has), and a request that gets no answer throws `GitHubNoAnswer`.
   *
   * @param installationId The installation the token acts for.
   * @param repositoryIds The repositories it may read: at least one.
   * @param options The caller's signal and the request's deadline.
   * @throws TypeError when `repositoryIds` is empty, before any request: GitHub answers a token request that names no
   * repository with a token for every repository the installation reaches.
   */
  async installationToken(installationId: number, repositoryIds: readonly number[], options: InstallationTokenOptions = {}): Promise<string> {
    if (repositoryIds.length === 0) {
      throw new TypeError('An installation token needs at least one repository id: with none, GitHub mints one for every repository of the installation');
    }
    const key = `${installationId}:${[...repositoryIds].sort((a, b) => a - b).join(',')}`;
    return this.minted(installationId, key, { repository_ids: repositoryIds }, options);
  }

  /**
   * An installation token that reads the metadata of every repository the installation reaches and nothing else
   * (`permissions: { metadata: 'read' }`, no repository named): enough to list the installation's repositories
   * (`repositoriesOfInstallation`), never to read a file. Held as `installationToken` holds its tokens. A refusal
   * throws `GitHubApiError` (404 for an installation GitHub no longer has), and a request that gets no answer throws
   * `GitHubNoAnswer`.
   *
   * @param installationId The installation the token acts for.
   * @param options The caller's signal and the request's deadline.
   */
  async metadataToken(installationId: number, options: InstallationTokenOptions = {}): Promise<string> {
    return this.minted(installationId, `${installationId}:metadata`, { permissions: { metadata: 'read' } }, options);
  }

  /** The token held under `key` while it has more than five minutes left, or a new one minted with `body` and held. */
  private async minted(installationId: number, key: string, body: Record<string, unknown>, options: InstallationTokenOptions): Promise<string> {
    const now = Date.now();
    const held = this.held.get(key);
    if (held !== undefined && now < held.expiresAt - RENEW_BEFORE_MS) return held.token;
    // Tokens past their end are dropped as new ones are minted, so the map holds no more than the live ones.
    for (const [other, entry] of this.held) if (entry.expiresAt <= now) this.held.delete(other);
    const answer = objectOf(
      await githubFetch(this.fetchImpl, `${this.apiBase}/app/installations/${installationId}/access_tokens`, {
        token: this.jwt(),
        method: 'POST',
        body: JSON.stringify(body),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      }),
      'an installation token',
    );
    const token = stringIn(answer, 'token', 'an installation token');
    this.held.set(key, { token, expiresAt: Date.parse(stringIn(answer, 'expires_at', 'an installation token')) });
    return token;
  }
}
