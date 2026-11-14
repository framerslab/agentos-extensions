// @ts-nocheck
/**
 * @fileoverview Cloudflare REST API service layer.
 *
 * Wraps the Cloudflare API v4 for Pages project deployment, DNS record
 * management, and Worker script deployment.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloudflareConfig {
  /** Cloudflare API token (from https://dash.cloudflare.com/profile/api-tokens) */
  apiToken: string;
  /** Cloudflare Account ID */
  accountId: string;
  /** API base URL (defaults to https://api.cloudflare.com/client/v4) */
  baseUrl?: string;
}

export interface CloudflarePagesProject {
  id: string;
  name: string;
  subdomain: string;
  productionBranch: string;
  createdOn: string;
  domains: string[];
  source?: { type: string; config?: { owner: string; repo_name: string; production_branch: string } };
  latestDeployment?: CloudflareDeployment;
}

export interface CloudflareDeployment {
  id: string;
  projectId: string;
  projectName: string;
  url: string;
  environment: 'production' | 'preview';
  createdOn: string;
  modifiedOn: string;
  latestStage: { name: string; status: 'idle' | 'active' | 'success' | 'failure' };
  deploymentTrigger?: { type: string; metadata?: { branch: string; commitHash: string; commitMessage: string } };
  stages: Array<{ name: string; status: string; startedOn?: string; endedOn?: string }>;
}

export interface CloudflareDnsRecord {
  id: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SRV' | 'CAA';
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  comment?: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
}

export interface CloudflareWorker {
  id: string;
  tag: string;
  etag: string;
  size: number;
  createdOn: string;
  modifiedOn: string;
}

export interface DeployPagesResult {
  id: string;
  url: string;
  environment: string;
  projectName: string;
  latestStage: { name: string; status: string };
}

export interface CreatePagesProjectOptions {
  /** Git repository URL (e.g. "https://github.com/user/repo") */
  gitUrl: string;
  /** Pages project name (inferred from the repository name if omitted) */
  projectName?: string;
  /** Production branch (defaults to "main") */
  productionBranch?: string;
  /** Build command (e.g. "npm run build") */
  buildCommand?: string;
  /** Build output directory (e.g. "dist", "build", ".next") */
  buildOutputDirectory?: string;
  /** Environment variables for the build */
  envVars?: Record<string, string>;
}

export interface DeployWorkerOptions {
  /** Worker script name */
  name: string;
  /** JavaScript/TypeScript source code */
  script: string;
  /** Route patterns (e.g. ["example.com/*"]) */
  routes?: string[];
  /** Compatibility date (e.g. "2024-01-01") */
  compatibilityDate?: string;
  /** Environment variables / secrets bindings */
  bindings?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CloudflareService {
  private config: CloudflareConfig;
  private running = false;

  constructor(config: CloudflareConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl ?? 'https://api.cloudflare.com/client/v4',
    };
  }

  async initialize(): Promise<void> {
    // Validate token by verifying the token
    const res = await this.fetch('/user/tokens/verify');
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Cloudflare auth failed: ${res.status} ${body}`);
    }
    this.running = true;
  }

  async shutdown(): Promise<void> {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Pages Projects ──────────────────────────────────────────────────────

  /** List all Pages projects. */
  async listProjects(limit = 25): Promise<CloudflarePagesProject[]> {
    const res = await this.fetch(
      `/accounts/${this.config.accountId}/pages/projects?per_page=${limit}`,
    );
    const data = await this.json(res);
    return (data.result ?? []).map((p: any) => this.mapProject(p));
  }

  /** Get a Pages project by name. */
  async getProject(projectName: string): Promise<CloudflarePagesProject> {
    const res = await this.fetch(
      `/accounts/${this.config.accountId}/pages/projects/${encodeURIComponent(projectName)}`,
    );
    const data = await this.json(res);
    return this.mapProject(data.result);
  }

  /** Create a new Pages project. */
  async createProject(
    name: string,
    opts?: {
      productionBranch?: string;
      buildCommand?: string;
      buildOutputDirectory?: string;
      gitUrl?: string;
    },
  ): Promise<CloudflarePagesProject> {
    const body: Record<string, unknown> = {
      name,
      production_branch: opts?.productionBranch ?? 'main',
    };

    if (opts?.buildCommand || opts?.buildOutputDirectory) {
      body.build_config = {
        ...(opts?.buildCommand ? { build_command: opts.buildCommand } : {}),
        ...(opts?.buildOutputDirectory ? { destination_dir: opts.buildOutputDirectory } : {}),
      };
    }

    if (opts?.gitUrl) {
      const { owner, repo } = this.parseGitUrl(opts.gitUrl);
      body.source = {
        type: 'github',
        config: {
          owner,
          repo_name: repo,
          production_branch: opts?.productionBranch ?? 'main',
        },
      };
    }

    const res = await this.fetch(
      `/accounts/${this.config.accountId}/pages/projects`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const data = await this.json(res);
    return this.mapProject(data.result);
  }

  // ── Deployments ─────────────────────────────────────────────────────────

  /** Create a deployment for a Pages project (triggers build from latest commit). */
  async createDeployment(
    projectName: string,
    opts?: { branch?: string },
  ): Promise<DeployPagesResult> {
    const formData = new FormData();
    if (opts?.branch) {
      formData.append('branch', opts.branch);
    }

    const res = await this.fetch(
      `/accounts/${this.config.accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
      {
        method: 'POST',
        body: formData,
        headers: {}, // Let fetch set content-type for FormData
      },
    );
    const data = await this.json(res);
    const d = data.result;
    return {
      id: d.id,
      url: d.url ? (d.url.startsWith('http') ? d.url : `https://${d.url}`) : '',
      environment: d.environment ?? 'production',
      projectName: d.project_name ?? projectName,
      latestStage: d.latest_stage ?? { name: 'queued', status: 'idle' },
    };
  }

  /** Deploy from a Git URL — creates project if needed, then triggers deployment. */
  async deployFromGit(opts: CreatePagesProjectOptions): Promise<DeployPagesResult> {
    const projectName = opts.projectName || this.inferProjectName(opts.gitUrl);

    // Try to get existing project
    let _project: CloudflarePagesProject | null = null;
    try {
      _project = await this.getProject(projectName);
    } catch {
      // Project doesn't exist — create it
      _project = await this.createProject(projectName, {
        gitUrl: opts.gitUrl,
        productionBranch: opts.productionBranch,
        buildCommand: opts.buildCommand,
        buildOutputDirectory: opts.buildOutputDirectory,
      });
    }

    // Set env vars if provided
    if (opts.envVars && Object.keys(opts.envVars).length > 0) {
      await this.setProjectEnvVars(projectName, opts.envVars);
    }

    // Trigger deployment
    return this.createDeployment(projectName, { branch: opts.productionBranch });
  }

  /** Get deployment status. */
  async getDeployment(
    projectName: string,
    deploymentId: string,
  ): Promise<CloudflareDeployment> {
    const res = await this.fetch(
      `/accounts/${this.config.accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments/${deploymentId}`,
    );
    const data = await this.json(res);
    return this.mapDeployment(data.result);
  }

  /** List recent deployments for a project. */
  async listDeployments(
    projectName: string,
    limit = 10,
  ): Promise<CloudflareDeployment[]> {
    const res = await this.fetch(
      `/accounts/${this.config.accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments?per_page=${limit}`,
    );
    const data = await this.json(res);
    return (data.result ?? []).map((d: any) => this.mapDeployment(d));
  }

  /** Set environment variables on a Pages project. */
  async setProjectEnvVars(
    projectName: string,
    vars: Record<string, string>,
    environment: 'production' | 'preview' = 'production',
  ): Promise<void> {
    const envVarMap: Record<string, { value: string; type: string }> = {};
    for (const [key, value] of Object.entries(vars)) {
      envVarMap[key] = { value, type: 'plain_text' };
    }

    const body = {
      deployment_configs: {
        [environment]: {
          env_vars: envVarMap,
        },
      },
    };

    await this.fetch(
      `/accounts/${this.config.accountId}/pages/projects/${encodeURIComponent(projectName)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
  }

  // ── DNS ─────────────────────────────────────────────────────────────────

  /** Look up a zone by domain name. */
  async getZoneByDomain(domain: string): Promise<CloudflareZone> {
    const res = await this.fetch(`/zones?name=${encodeURIComponent(domain)}`);
    const data = await this.json(res);
    const zones = data.result ?? [];
    if (zones.length === 0) {
      throw new Error(`No Cloudflare zone found for domain: ${domain}`);
    }
    return this.mapZone(zones[0]);
  }

  /** List DNS records for a zone. */
  async listDnsRecords(
    zoneId: string,
    opts?: { type?: string; name?: string },
  ): Promise<CloudflareDnsRecord[]> {
    let path = `/zones/${zoneId}/dns_records?per_page=100`;
    if (opts?.type) path += `&type=${opts.type}`;
    if (opts?.name) path += `&name=${encodeURIComponent(opts.name)}`;

    const res = await this.fetch(path);
    const data = await this.json(res);
    return (data.result ?? []).map((r: any) => this.mapDnsRecord(r));
  }

  /** Create a DNS record. */
  async createDnsRecord(
    zoneId: string,
    record: {
      type: string;
      name: string;
      content: string;
      ttl?: number;
      proxied?: boolean;
      priority?: number;
      comment?: string;
    },
  ): Promise<CloudflareDnsRecord> {
    const body: Record<string, unknown> = {
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: record.ttl ?? 1, // 1 = auto
      proxied: record.proxied ?? false,
    };
    if (record.priority !== undefined) body.priority = record.priority;
    if (record.comment) body.comment = record.comment;

    const res = await this.fetch(`/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await this.json(res);
    return this.mapDnsRecord(data.result);
  }

  /** Update a DNS record. */
  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    record: {
      type?: string;
      name?: string;
      content?: string;
      ttl?: number;
      proxied?: boolean;
      priority?: number;
      comment?: string;
    },
  ): Promise<CloudflareDnsRecord> {
    const res = await this.fetch(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify(record),
    });
    const data = await this.json(res);
    return this.mapDnsRecord(data.result);
  }

  /** Delete a DNS record. */
  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.fetch(`/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
    });
  }

  // ── Workers ─────────────────────────────────────────────────────────────

  /** Deploy a Worker script. */
  async deployWorker(opts: DeployWorkerOptions): Promise<CloudflareWorker> {
    // Upload the script
    const formData = new FormData();

    const metadata: Record<string, unknown> = {
      main_module: 'worker.js',
      compatibility_date: opts.compatibilityDate ?? '2024-01-01',
    };

    // Add bindings for env vars / secrets
    if (opts.bindings && Object.keys(opts.bindings).length > 0) {
      metadata.bindings = Object.entries(opts.bindings).map(([name, text]) => ({
        type: 'plain_text',
        name,
        text,
      }));
    }

    formData.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    );
    formData.append(
      'worker.js',
      new Blob([opts.script], { type: 'application/javascript+module' }),
      'worker.js',
    );

    const res = await this.fetch(
      `/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(opts.name)}`,
      {
        method: 'PUT',
        body: formData,
        headers: {}, // Let fetch set content-type for FormData
      },
    );
    const data = await this.json(res);
    const result = data.result;

    // Set up routes if provided
    if (opts.routes && opts.routes.length > 0) {
      for (const pattern of opts.routes) {
        try {
          // Determine zone from route pattern
          const routeDomain = pattern.replace(/\/\*$/, '').replace(/^\*\./, '');
          const zone = await this.getZoneByDomain(routeDomain);
          await this.fetch(`/zones/${zone.id}/workers/routes`, {
            method: 'POST',
            body: JSON.stringify({ pattern, script: opts.name }),
          });
        } catch {
          // Route setup is best-effort — zone may not be managed
        }
      }
    }

    return {
      id: result?.id ?? opts.name,
      tag: result?.tag ?? '',
      etag: result?.etag ?? '',
      size: result?.size ?? 0,
      createdOn: result?.created_on ?? new Date().toISOString(),
      modifiedOn: result?.modified_on ?? new Date().toISOString(),
    };
  }

  /** List Worker scripts. */
  async listWorkers(): Promise<CloudflareWorker[]> {
    const res = await this.fetch(
      `/accounts/${this.config.accountId}/workers/scripts`,
    );
    const data = await this.json(res);
    return (data.result ?? []).map((w: any) => ({
      id: w.id,
      tag: w.tag ?? '',
      etag: w.etag ?? '',
      size: w.size ?? 0,
      createdOn: w.created_on ?? '',
      modifiedOn: w.modified_on ?? '',
    }));
  }

  /** Delete a Worker script. */
  async deleteWorker(name: string): Promise<void> {
    await this.fetch(
      `/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async fetch(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.apiToken}`,
      ...(init?.headers ?? {}),
    };

    // Only set Content-Type for non-FormData requests
    if (!(init?.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    return globalThis.fetch(url, {
      ...init,
      headers,
    });
  }

  private async json(res: Response): Promise<any> {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cloudflare API ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json();
  }

  private parseGitUrl(url: string): { owner: string; repo: string } {
    const match = url.match(/(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Cannot parse git URL: ${url}`);
    return { owner: match[1], repo: match[2] };
  }

  private inferProjectName(gitUrl: string): string {
    const { repo } = this.parseGitUrl(gitUrl);
    return repo.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  private mapProject(data: any): CloudflarePagesProject {
    return {
      id: data.id,
      name: data.name,
      subdomain: data.subdomain ?? `${data.name}.pages.dev`,
      productionBranch: data.production_branch ?? 'main',
      createdOn: data.created_on ?? '',
      domains: data.domains ?? [],
      source: data.source
        ? {
            type: data.source.type,
            config: data.source.config
              ? {
                  owner: data.source.config.owner,
                  repo_name: data.source.config.repo_name,
                  production_branch: data.source.config.production_branch,
                }
              : undefined,
          }
        : undefined,
      latestDeployment: data.latest_deployment
        ? this.mapDeployment(data.latest_deployment)
        : undefined,
    };
  }

  private mapDeployment(data: any): CloudflareDeployment {
    return {
      id: data.id,
      projectId: data.project_id ?? '',
      projectName: data.project_name ?? '',
      url: data.url ? (data.url.startsWith('http') ? data.url : `https://${data.url}`) : '',
      environment: data.environment ?? 'production',
      createdOn: data.created_on ?? '',
      modifiedOn: data.modified_on ?? '',
      latestStage: data.latest_stage ?? { name: 'queued', status: 'idle' },
      deploymentTrigger: data.deployment_trigger
        ? {
            type: data.deployment_trigger.type,
            metadata: data.deployment_trigger.metadata
              ? {
                  branch: data.deployment_trigger.metadata.branch ?? '',
                  commitHash: data.deployment_trigger.metadata.commit_hash ?? '',
                  commitMessage: data.deployment_trigger.metadata.commit_message ?? '',
                }
              : undefined,
          }
        : undefined,
      stages: (data.stages ?? []).map((s: any) => ({
        name: s.name,
        status: s.status,
        startedOn: s.started_on,
        endedOn: s.ended_on,
      })),
    };
  }

  private mapDnsRecord(data: any): CloudflareDnsRecord {
    return {
      id: data.id,
      type: data.type,
      name: data.name,
      content: data.content,
      ttl: data.ttl ?? 1,
      proxied: data.proxied,
      priority: data.priority,
      comment: data.comment,
    };
  }

  private mapZone(data: any): CloudflareZone {
    return {
      id: data.id,
      name: data.name,
      status: data.status,
      nameServers: data.name_servers ?? [],
    };
  }
}
