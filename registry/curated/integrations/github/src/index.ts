// @ts-nocheck
/**
 * @fileoverview GitHub Extension for AgentOS.
 *
 * Provides GitHub API tools for searching, managing issues/PRs,
 * reading files, creating gists, managing releases, and triggering CI.
 *
 * @module @framers/agentos-ext-github
 */

import { execSync } from 'node:child_process';
import { GitHubService } from './GitHubService.js';
import { GitHubSearchTool } from './tools/search.js';
import { GitHubIssueListTool } from './tools/issueList.js';
import { GitHubIssueCreateTool } from './tools/issueCreate.js';
import { GitHubIssueUpdateTool } from './tools/issueUpdate.js';
import { GitHubCommentListTool } from './tools/commentList.js';
import { GitHubPrListTool } from './tools/prList.js';
import { GitHubPrCreateTool } from './tools/prCreate.js';
import { GitHubPrDiffTool } from './tools/prDiff.js';
import { GitHubPrReviewTool } from './tools/prReview.js';
import { GitHubPrMergeTool } from './tools/prMerge.js';
import { GitHubPrCommentListTool } from './tools/prCommentList.js';
import { GitHubPrCommentCreateTool } from './tools/prCommentCreate.js';
import { GitHubFileReadTool } from './tools/fileRead.js';
import { GitHubGistCreateTool } from './tools/gistCreate.js';
import { GitHubRepoListTool } from './tools/repoList.js';
import { GitHubRepoInfoTool } from './tools/repoInfo.js';
import { GitHubRepoCreateTool } from './tools/repoCreate.js';
import { GitHubRepoIndexTool } from './tools/repoIndex.js';
import { GitHubReleaseListTool } from './tools/releaseList.js';
import { GitHubReleaseCreateTool } from './tools/releaseCreate.js';
import { GitHubActionsListTool } from './tools/actionsList.js';
import { GitHubActionsTriggerTool } from './tools/actionsTrigger.js';
import { GitHubFileWriteTool } from './tools/fileWrite.js';
import { GitHubBranchListTool } from './tools/branchList.js';
import { GitHubBranchCreateTool } from './tools/branchCreate.js';
import { GitHubCommitListTool } from './tools/commitList.js';
import { GitHubRepoIndexer } from './GitHubRepoIndexer.js';
import { PACKAGE_VERSION, warnWhenVersionUnknown } from './packageVersion.js';

export interface GitHubExtensionOptions {
  token?: string;
  priority?: number;
}

function resolveToken(
  options: GitHubExtensionOptions,
  secrets?: Record<string, string>,
): string {
  if (options.token) return options.token;
  if (secrets?.['github.token']) return secrets['github.token'];
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  // Fallback: try gh CLI auth
  try {
    const token = execSync('gh auth token', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated
  }

  throw new Error(
    'GitHub token not found. Provide via options.token, secrets["github.token"], ' +
    'GITHUB_TOKEN env var, or authenticate with `gh auth login`.',
  );
}

export function createExtensionPack(context: {
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
  logger?: { info: (...args: unknown[]) => void; warn?: (message: string) => void };
  [key: string]: unknown;
}) {
  const options = (context.options ?? {}) as GitHubExtensionOptions & {
    secrets?: Record<string, string>;
  };
  const token = resolveToken(options, options.secrets ?? context.secrets);
  const service = new GitHubService(token);
  const priority = options.priority ?? 30;

  const tools = [
    new GitHubSearchTool(service),
    new GitHubIssueListTool(service),
    new GitHubIssueCreateTool(service),
    new GitHubIssueUpdateTool(service),
    new GitHubCommentListTool(service),
    new GitHubPrListTool(service),
    new GitHubPrCreateTool(service),
    new GitHubPrDiffTool(service),
    new GitHubPrReviewTool(service),
    new GitHubPrMergeTool(service),
    new GitHubPrCommentListTool(service),
    new GitHubPrCommentCreateTool(service),
    new GitHubFileReadTool(service),
    new GitHubGistCreateTool(service),
    new GitHubRepoListTool(service),
    new GitHubRepoInfoTool(service),
    new GitHubRepoCreateTool(service),
    new GitHubRepoIndexTool(service),
    new GitHubReleaseListTool(service),
    new GitHubReleaseCreateTool(service),
    new GitHubActionsListTool(service),
    new GitHubActionsTriggerTool(service),
    new GitHubFileWriteTool(service),
    new GitHubBranchListTool(service),
    new GitHubBranchCreateTool(service),
    new GitHubCommitListTool(service),
  ];
  warnWhenVersionUnknown(context.logger);

  return {
    name: '@framers/agentos-ext-github',
    version: PACKAGE_VERSION,
    // Each id is the tool's own name, the id manifest.json lists it under.
    descriptors: tools.map((tool) => ({
      id: tool.name,
      kind: 'tool' as const,
      priority,
      payload: tool,
    })),

    onActivate: async () => {
      await service.initialize();
      context.logger?.info(`[GitHub] Extension activated (user: ${service.getUsername()})`);
    },

    onDeactivate: async () => {
      context.logger?.info('[GitHub] Extension deactivated');
    },
  };
}

export { GitHubService } from './GitHubService.js';
export { GitHubSearchTool } from './tools/search.js';
export { GitHubIssueListTool } from './tools/issueList.js';
export { GitHubIssueCreateTool } from './tools/issueCreate.js';
export { GitHubIssueUpdateTool } from './tools/issueUpdate.js';
export { GitHubCommentListTool } from './tools/commentList.js';
export { GitHubPrListTool } from './tools/prList.js';
export { GitHubPrCreateTool } from './tools/prCreate.js';
export { GitHubPrDiffTool } from './tools/prDiff.js';
export { GitHubPrReviewTool } from './tools/prReview.js';
export { GitHubPrMergeTool } from './tools/prMerge.js';
export { GitHubPrCommentListTool } from './tools/prCommentList.js';
export { GitHubPrCommentCreateTool } from './tools/prCommentCreate.js';
export { GitHubFileReadTool } from './tools/fileRead.js';
export { GitHubGistCreateTool } from './tools/gistCreate.js';
export { GitHubRepoListTool } from './tools/repoList.js';
export { GitHubRepoInfoTool } from './tools/repoInfo.js';
export { GitHubRepoCreateTool } from './tools/repoCreate.js';
export { GitHubRepoIndexTool } from './tools/repoIndex.js';
export { GitHubReleaseListTool } from './tools/releaseList.js';
export { GitHubReleaseCreateTool } from './tools/releaseCreate.js';
export { GitHubActionsListTool } from './tools/actionsList.js';
export { GitHubActionsTriggerTool } from './tools/actionsTrigger.js';
export { GitHubFileWriteTool } from './tools/fileWrite.js';
export { GitHubBranchListTool } from './tools/branchList.js';
export { GitHubBranchCreateTool } from './tools/branchCreate.js';
export { GitHubCommitListTool } from './tools/commitList.js';
/** The repository indexer, the repositories it indexes by default, and the types of its options. */
export { GitHubRepoIndexer, ECOSYSTEM_REPOS, type GitHubRepoIndexerOptions, type IndexedRepository } from './GitHubRepoIndexer.js';
export default createExtensionPack;
