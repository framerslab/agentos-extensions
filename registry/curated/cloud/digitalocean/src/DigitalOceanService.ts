// @ts-nocheck
/**
 * @fileoverview DigitalOcean REST API service layer.
 *
 * Wraps the DigitalOcean API v2 for App Platform management, Droplet
 * provisioning, DNS record management, and deployment triggering.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigitalOceanConfig {
  /** DigitalOcean personal access token */
  token: string;
  /** API base URL (defaults to https://api.digitalocean.com/v2) */
  baseUrl?: string;
}

export interface DOApp {
  id: string;
  defaultIngress: string;
  liveUrl: string;
  activeDeployment?: DODeployment;
  spec: DOAppSpec;
  createdAt: string;
  updatedAt: string;
}

export interface DOAppSpec {
  name: string;
  region?: string;
  services?: DOAppServiceSpec[];
  staticSites?: DOAppStaticSiteSpec[];
}

export interface DOAppServiceSpec {
  name: string;
  gitSource?: { repoCloneUrl: string; branch: string };
  buildCommand?: string;
  runCommand?: string;
  environmentSlug?: string;
  instanceCount?: number;
  instanceSizeSlug?: string;
  envs?: DOAppEnvVar[];
}

export interface DOAppStaticSiteSpec {
  name: string;
  gitSource?: { repoCloneUrl: string; branch: string };
  buildCommand?: string;
  outputDir?: string;
  envs?: DOAppEnvVar[];
}

export interface DOAppEnvVar {
  key: string;
  value?: string;
  scope?: 'RUN_TIME' | 'BUILD_TIME' | 'RUN_AND_BUILD_TIME';
  type?: 'GENERAL' | 'SECRET';
}

export interface DODeployment {
  id: string;
  phase: 'UNKNOWN' | 'PENDING_BUILD' | 'BUILDING' | 'PENDING_DEPLOY' | 'DEPLOYING' | 'ACTIVE' | 'SUPERSEDED' | 'ERROR';
  createdAt: string;
  updatedAt: string;
  cause: string;
}

export interface DODroplet {
  id: number;
  name: string;
  status: 'new' | 'active' | 'off' | 'archive';
  memory: number;
  vcpus: number;
  disk: number;
  region: { slug: string; name: string };
  image: { id: number; slug: string; name: string };
  sizeSlug: string;
  networks: {
    v4: Array<{ ipAddress: string; type: string }>;
    v6: Array<{ ipAddress: string; type: string }>;
  };
  tags: string[];
  createdAt: string;
}

export interface DODomain {
  name: string;
  ttl: number;
  zoneFile: string;
}

export interface DODomainRecord {
  id: number;
  type: string;
  name: string;
  data: string;
  priority: number | null;
  port: number | null;
  ttl: number;
  weight: number | null;
  flags: number | null;
  tag: string | null;
}

export interface CreateAppOptions {
  /** App name */
  name: string;
  /** Git repository clone URL */
  gitUrl: string;
  /** Git branch (default: main) */
  branch?: string;
  /** Region slug (default: nyc) */
  region?: string;
  /** Build command */
  buildCommand?: string;
  /** Run command (for services) */
  runCommand?: string;
  /** Output directory (for static sites) */
  outputDir?: string;
  /** Whether this is a static site (default: false, treated as service) */
  isStatic?: boolean;
  /** Environment variables */
  envVars?: Record<string, string>;
  /** Instance size slug (e.g. "basic-xxs", "professional-xs") */
  instanceSizeSlug?: string;
}

export interface CreateDropletOptions {
  /** Droplet name */
  name: string;
  /** Region slug (e.g. "nyc1", "sfo3", "ams3") */
  region: string;
  /** Size slug (e.g. "s-1vcpu-1gb", "s-2vcpu-4gb") */
  size: string;
  /** Image slug or ID (e.g. "ubuntu-24-04-x64", "docker-20-04") */
  image: string;
  /** SSH key IDs or fingerprints */
  sshKeys?: (string | number)[];
  /** User data script (cloud-init) */
  userData?: string;
  /** Enable backups */
  backups?: boolean;
  /** Enable IPv6 */
  ipv6?: boolean;
  /** Tags */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DigitalOceanService {
  private config: DigitalOceanConfig;
  private running = false;

  constructor(config: DigitalOceanConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl ?? 'https://api.digitalocean.com/v2',
    };
  }

  async initialize(): Promise<void> {
    // Validate token by fetching account info
    const res = await this.fetch('/account');
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DigitalOcean auth failed: ${res.status} ${body}`);
    }
    this.running = true;
  }

  async shutdown(): Promise<void> {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  // -- Apps (App Platform) --------------------------------------------------

  /** Create an App Platform app from a spec. */
  async createApp(opts: CreateAppOptions): Promise<DOApp> {
    const envs: DOAppEnvVar[] = opts.envVars
      ? Object.entries(opts.envVars).map(([key, value]) => ({
          key,
          value,
          scope: 'RUN_AND_BUILD_TIME' as const,
          type: 'GENERAL' as const,
        }))
      : [];

    const gitSource = {
      repo_clone_url: opts.gitUrl,
      branch: opts.branch ?? 'main',
    };

    const spec: Record<string, unknown> = {
      name: opts.name,
      region: opts.region ?? 'nyc',
    };

    if (opts.isStatic) {
      spec.static_sites = [{
        name: opts.name,
        git: gitSource,
        build_command: opts.buildCommand,
        // Unset, App Platform scans _static, dist, public and build:
        // https://docs.digitalocean.com/products/app-platform/reference/app-spec/
        output_dir: opts.outputDir,
        envs: envs.length > 0 ? envs : undefined,
      }];
    } else {
      spec.services = [{
        name: opts.name,
        git: gitSource,
        build_command: opts.buildCommand,
        run_command: opts.runCommand,
        environment_slug: 'node-js',
        instance_count: 1,
        instance_size_slug: opts.instanceSizeSlug ?? 'basic-xxs',
        envs: envs.length > 0 ? envs : undefined,
      }];
    }

    const res = await this.fetch('/apps', {
      method: 'POST',
      body: JSON.stringify({ spec }),
    });
    const data = await this.json(res);
    return this.mapApp(data.app);
  }

  /** List all apps. */
  async listApps(page = 1, perPage = 20): Promise<DOApp[]> {
    const res = await this.fetch(`/apps?page=${page}&per_page=${perPage}`);
    const data = await this.json(res);
    return (data.apps ?? []).map((a: any) => this.mapApp(a));
  }

  /** Get an app by ID. */
  async getApp(appId: string): Promise<DOApp> {
    const res = await this.fetch(`/apps/${appId}`);
    const data = await this.json(res);
    return this.mapApp(data.app);
  }

  /** Delete an app. */
  async deleteApp(appId: string): Promise<void> {
    const res = await this.fetch(`/apps/${appId}`, { method: 'DELETE' });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DigitalOcean API ${res.status}: ${text.slice(0, 500)}`);
    }
  }

  /** Trigger a new deployment for an app. */
  async createDeployment(appId: string, forceBuild = false): Promise<DODeployment> {
    const body: Record<string, unknown> = {};
    if (forceBuild) body.force_build = true;

    const res = await this.fetch(`/apps/${appId}/deployments`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await this.json(res);
    return this.mapDeployment(data.deployment);
  }

  // -- Droplets -------------------------------------------------------------

  /** Create a new Droplet. */
  async createDroplet(opts: CreateDropletOptions): Promise<DODroplet> {
    const body: Record<string, unknown> = {
      name: opts.name,
      region: opts.region,
      size: opts.size,
      image: opts.image,
    };

    if (opts.sshKeys?.length) body.ssh_keys = opts.sshKeys;
    if (opts.userData) body.user_data = opts.userData;
    if (opts.backups) body.backups = true;
    if (opts.ipv6) body.ipv6 = true;
    if (opts.tags?.length) body.tags = opts.tags;

    const res = await this.fetch('/droplets', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await this.json(res);
    return this.mapDroplet(data.droplet);
  }

  /** List all Droplets. */
  async listDroplets(page = 1, perPage = 20, tag?: string): Promise<DODroplet[]> {
    let url = `/droplets?page=${page}&per_page=${perPage}`;
    if (tag) url += `&tag_name=${encodeURIComponent(tag)}`;
    const res = await this.fetch(url);
    const data = await this.json(res);
    return (data.droplets ?? []).map((d: any) => this.mapDroplet(d));
  }

  /** Delete a Droplet by ID. */
  async deleteDroplet(dropletId: number): Promise<void> {
    const res = await this.fetch(`/droplets/${dropletId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(`DigitalOcean API ${res.status}: ${text.slice(0, 500)}`);
    }
  }

  // -- DNS ------------------------------------------------------------------

  /** List all domains. */
  async listDomains(): Promise<DODomain[]> {
    const res = await this.fetch('/domains');
    const data = await this.json(res);
    return (data.domains ?? []).map((d: any) => ({
      name: d.name,
      ttl: d.ttl ?? 1800,
      zoneFile: d.zone_file ?? '',
    }));
  }

  /** Add a domain. */
  async addDomain(name: string): Promise<DODomain> {
    const res = await this.fetch('/domains', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    const data = await this.json(res);
    return {
      name: data.domain.name,
      ttl: data.domain.ttl ?? 1800,
      zoneFile: data.domain.zone_file ?? '',
    };
  }

  /** List DNS records for a domain. */
  async listDomainRecords(domain: string): Promise<DODomainRecord[]> {
    const res = await this.fetch(`/domains/${encodeURIComponent(domain)}/records`);
    const data = await this.json(res);
    return (data.domain_records ?? []).map((r: any) => this.mapDomainRecord(r));
  }

  /** Create a DNS record. */
  async createDomainRecord(domain: string, record: {
    type: string;
    name: string;
    data: string;
    ttl?: number;
    priority?: number;
    port?: number;
    weight?: number;
    flags?: number;
    tag?: string;
  }): Promise<DODomainRecord> {
    const res = await this.fetch(`/domains/${encodeURIComponent(domain)}/records`, {
      method: 'POST',
      body: JSON.stringify(record),
    });
    const data = await this.json(res);
    return this.mapDomainRecord(data.domain_record);
  }

  /** Update a DNS record. */
  async updateDomainRecord(domain: string, recordId: number, fields: {
    type?: string;
    name?: string;
    data?: string;
    ttl?: number;
    priority?: number;
    port?: number;
    weight?: number;
    flags?: number;
    tag?: string;
  }): Promise<DODomainRecord> {
    const res = await this.fetch(`/domains/${encodeURIComponent(domain)}/records/${recordId}`, {
      method: 'PUT',
      body: JSON.stringify(fields),
    });
    const data = await this.json(res);
    return this.mapDomainRecord(data.domain_record);
  }

  /** Delete a DNS record. */
  async deleteDomainRecord(domain: string, recordId: number): Promise<void> {
    const res = await this.fetch(`/domains/${encodeURIComponent(domain)}/records/${recordId}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 204) {
      const text = await res.text();
      throw new Error(`DigitalOcean API ${res.status}: ${text.slice(0, 500)}`);
    }
  }

  // -- Helpers --------------------------------------------------------------

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.config.baseUrl}${path}`;
    return globalThis.fetch(url, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> ?? {}),
      },
    });
  }

  private async json(res: Response): Promise<any> {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DigitalOcean API ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json();
  }

  private mapApp(data: any): DOApp {
    return {
      id: data.id,
      defaultIngress: data.default_ingress ?? '',
      liveUrl: data.live_url ?? '',
      activeDeployment: data.active_deployment
        ? this.mapDeployment(data.active_deployment)
        : undefined,
      spec: {
        name: data.spec?.name ?? '',
        region: data.spec?.region,
        services: data.spec?.services?.map((s: any) => ({
          name: s.name,
          gitSource: s.git ? { repoCloneUrl: s.git.repo_clone_url, branch: s.git.branch } : undefined,
          buildCommand: s.build_command,
          runCommand: s.run_command,
          environmentSlug: s.environment_slug,
          instanceCount: s.instance_count,
          instanceSizeSlug: s.instance_size_slug,
          envs: s.envs,
        })),
        staticSites: data.spec?.static_sites?.map((s: any) => ({
          name: s.name,
          gitSource: s.git ? { repoCloneUrl: s.git.repo_clone_url, branch: s.git.branch } : undefined,
          buildCommand: s.build_command,
          outputDir: s.output_dir,
          envs: s.envs,
        })),
      },
      createdAt: data.created_at ?? '',
      updatedAt: data.updated_at ?? '',
    };
  }

  private mapDeployment(data: any): DODeployment {
    return {
      id: data.id,
      phase: data.phase ?? 'UNKNOWN',
      createdAt: data.created_at ?? '',
      updatedAt: data.updated_at ?? '',
      cause: data.cause ?? '',
    };
  }

  private mapDroplet(data: any): DODroplet {
    return {
      id: data.id,
      name: data.name,
      status: data.status ?? 'new',
      memory: data.memory ?? 0,
      vcpus: data.vcpus ?? 0,
      disk: data.disk ?? 0,
      region: {
        slug: data.region?.slug ?? '',
        name: data.region?.name ?? '',
      },
      image: {
        id: data.image?.id ?? 0,
        slug: data.image?.slug ?? '',
        name: data.image?.name ?? '',
      },
      sizeSlug: data.size_slug ?? data.size?.slug ?? '',
      networks: {
        v4: (data.networks?.v4 ?? []).map((n: any) => ({
          ipAddress: n.ip_address,
          type: n.type,
        })),
        v6: (data.networks?.v6 ?? []).map((n: any) => ({
          ipAddress: n.ip_address,
          type: n.type,
        })),
      },
      tags: data.tags ?? [],
      createdAt: data.created_at ?? '',
    };
  }

  private mapDomainRecord(data: any): DODomainRecord {
    return {
      id: data.id,
      type: data.type,
      name: data.name,
      data: data.data,
      priority: data.priority ?? null,
      port: data.port ?? null,
      ttl: data.ttl ?? 1800,
      weight: data.weight ?? null,
      flags: data.flags ?? null,
      tag: data.tag ?? null,
    };
  }
}
