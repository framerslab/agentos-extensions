// @ts-nocheck
/**
 * @fileoverview CfDeployPagesTool — deploy a Cloudflare Pages project from a Git repository.
 */

import type { CloudflareService, DeployPagesResult } from '../CloudflareService.js';

export interface CfDeployPagesInput {
  gitUrl: string;
  projectName?: string;
  productionBranch?: string;
  buildCommand?: string;
  buildOutputDirectory?: string;
  envVars?: Record<string, string>;
}

export class CfDeployPagesTool {
  readonly id = 'cfDeployPages';
  readonly name = 'cfDeployPages';
  readonly displayName = 'Deploy Cloudflare Pages';
  readonly description = 'Deploy a project to Cloudflare Pages from a Git repository URL. Creates the project if it does not exist. Supports static sites, Next.js, Astro, SvelteKit, Remix, and other full-stack frameworks with automatic build configuration.';
  readonly category = 'cloud';
  readonly version = '0.1.0';
  readonly hasSideEffects = true;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      gitUrl: { type: 'string', description: 'Git repository URL (e.g. "https://github.com/user/repo")' },
      projectName: { type: 'string', description: 'Pages project name (auto-generated from repo name if omitted)' },
      productionBranch: { type: 'string', description: 'Production branch name (default: "main")' },
      buildCommand: { type: 'string', description: 'Build command override (e.g. "npm run build")' },
      buildOutputDirectory: { type: 'string', description: 'Build output directory (e.g. "dist", "build", ".next")' },
      envVars: { type: 'object', description: 'Environment variables to set on the project (key-value pairs)' },
    },
    required: ['gitUrl'],
  };

  constructor(private service: CloudflareService) {}

  async execute(args: CfDeployPagesInput): Promise<{ success: boolean; data?: DeployPagesResult; error?: string }> {
    try {
      const result = await this.service.deployFromGit({
        gitUrl: args.gitUrl,
        projectName: args.projectName,
        productionBranch: args.productionBranch,
        buildCommand: args.buildCommand,
        buildOutputDirectory: args.buildOutputDirectory,
        envVars: args.envVars,
      });

      return { success: true, data: result };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
