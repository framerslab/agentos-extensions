// @ts-nocheck
/**
 * @fileoverview Site Deploy Orchestration Tool — deploy from source to any
 * cloud provider with optional domain registration and DNS configuration.
 *
 * This tool acts as a high-level orchestrator that delegates to per-provider
 * deploy tools and per-registrar domain tools via a `setToolExecutor()` pattern.
 * Similar to MultiChannelPostTool, it does not call cloud or registrar APIs
 * directly — it invokes other tools by name.
 *
 * Every delegated call names a tool a curated cloud or registrar pack
 * registers and passes the arguments that tool's inputSchema accepts
 * (test/pack-contract.test.ts checks this against the packs' own classes).
 * A provider whose deploy tool cannot take the given source is refused
 * before any tool is called.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type CloudProvider =
  | 'vercel'
  | 'cloudflare'
  | 'digitalocean'
  | 'netlify'
  | 'heroku'
  | 'aws'
  | 'linode'
  | 'railway'
  | 'flyio';

export type DomainRegistrar =
  | 'porkbun'
  | 'namecheap'
  | 'godaddy'
  | 'cloudflare';

export type Framework =
  | 'nextjs'
  | 'react'
  | 'vue'
  | 'svelte'
  | 'astro'
  | 'static'
  | 'node'
  | 'python'
  | 'auto';

/** Registrant contact for a new domain registration. */
export interface RegistrantContact {
  firstName: string;
  lastName: string;
  email: string;
  /** Phone in +CountryCode.Number form, e.g. "+1.5555550100". */
  phone: string;
  address1: string;
  address2?: string;
  city: string;
  /** State or province. */
  state: string;
  postalCode: string;
  /** Two-letter country code, e.g. "US". */
  country: string;
  organization?: string;
}

export interface SiteDeployInput {
  /** Git repository URL or local directory path. */
  source: string;
  /** Cloud provider to deploy to (default: auto-detect best fit). */
  cloudProvider?: CloudProvider;
  /** Project, site, app or bucket name on the provider. */
  projectName?: string;
  /** Custom domain to configure (optional). */
  domain?: string;
  /** Domain registrar for domain purchase (required if domain is not already registered). */
  domainRegistrar?: DomainRegistrar;
  /** Registrant contact, needed to register a new domain at Namecheap or GoDaddy. */
  registrant?: RegistrantContact;
  /** Framework/runtime (default: auto-detect). */
  framework?: Framework;
  /** Environment variables to set on the deployment. */
  envVars?: Record<string, string>;
  /** Build command override. */
  buildCommand?: string;
  /** Output directory override. */
  outputDirectory?: string;
  /** Preview the deployment plan without executing (default: false). */
  dryRun?: boolean;
}

export interface DeployStepResult {
  step: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface SiteDeployOutput {
  /** Detected or specified framework. */
  framework: string;
  /** Selected cloud provider. */
  cloudProvider: string;
  /** Deployment URL (if deployment succeeded). */
  deploymentUrl?: string;
  /** Custom domain status. */
  domainStatus?: 'configured' | 'pending_dns' | 'not_configured' | 'registration_failed';
  /** DNS instructions if manual setup is needed. */
  dnsInstructions?: string[];
  /** Per-step results for transparency. */
  steps: DeployStepResult[];
}

/* ------------------------------------------------------------------ */
/*  Tool executor callback type                                        */
/* ------------------------------------------------------------------ */

export type ToolExecutorFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ success: boolean; data?: any; error?: string }>;

/* ------------------------------------------------------------------ */
/*  Deploy plans: the real tool and its arguments per provider        */
/* ------------------------------------------------------------------ */

interface DeployOptions {
  source: string;
  framework: string;
  projectName?: string;
  envVars?: Record<string, string>;
  buildCommand?: string;
  outputDirectory?: string;
}

type DeployPlan =
  | { tool: string; args: Record<string, unknown> }
  | { tool?: string; error: string };

/** The deploy tool each curated cloud pack registers. */
const PROVIDER_TOOL_MAP: Record<CloudProvider, string> = {
  vercel: 'vercelDeploy',
  cloudflare: 'cfDeployPages',
  digitalocean: 'doCreateApp',
  netlify: 'netlifyDeploySite',
  heroku: 'herokuDeployApp',
  aws: 'awsDeployAmplify',
  linode: 'linodeDeployStackScript',
  railway: 'railwayDeployService',
  flyio: 'flyDeployApp',
};

/**
 * siteDeploy framework -> Vercel framework preset slug. Only unambiguous
 * matches are sent; Vercel detects the rest when the field is omitted.
 * Slugs: https://github.com/vercel/vercel/blob/main/packages/frameworks/src/frameworks.ts
 */
const VERCEL_FRAMEWORK: Record<string, string> = {
  nextjs: 'nextjs',
  astro: 'astro',
};

/** Frameworks whose build output is static files. */
const STATIC_FRAMEWORKS = new Set(['static', 'react', 'vue', 'svelte', 'astro']);

function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(source.trim());
}

function isTarballUrl(source: string): boolean {
  return /^https?:\/\/\S+\.(tar\.gz|tgz)(\?\S*)?$/i.test(source.trim());
}

/** "owner/repo" from a GitHub URL, or undefined for any other host. */
function githubRepo(source: string): string | undefined {
  const m = source
    .trim()
    .match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** A lowercase, hyphenated name from the last path segment of the source. */
function deriveName(source: string): string {
  const last = source.trim().replace(/[#?].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  const slug = last
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return slug || 'site';
}

function joinPath(dir: string, sub: string): string {
  return `${dir.replace(/\/+$/, '')}/${sub.replace(/^\.?\/+/, '')}`;
}

function unsupported(
  provider: string,
  tool: string,
  opts: DeployOptions,
  keys: Array<'envVars' | 'buildCommand' | 'outputDirectory'>,
): string | undefined {
  const given = keys.filter((k) => opts[k] !== undefined);
  if (given.length === 0) return undefined;
  return `${provider}'s deploy tool ${tool} does not take ${given.join(', ')}. Remove ${given.length > 1 ? 'them' : 'it'} or call ${tool} directly.`;
}

function needsGitSource(provider: string, tool: string, source: string): string | undefined {
  if (isGitUrl(source)) return undefined;
  return `${provider}'s deploy tool ${tool} deploys from a Git repository URL; "${source}" is not one. Push the directory to a Git repository and pass its URL, or choose aws, which deploys a local directory to S3.`;
}

function planDeploy(provider: CloudProvider, opts: DeployOptions): DeployPlan {
  const tool = PROVIDER_TOOL_MAP[provider];
  if (!tool) return { error: `Unknown cloud provider: ${provider}` };
  const { source } = opts;

  switch (provider) {
    case 'vercel': {
      const err = needsGitSource(provider, tool, source);
      if (err) return { tool, error: err };
      const args: Record<string, unknown> = { gitUrl: source };
      if (opts.projectName) args.projectName = opts.projectName;
      if (VERCEL_FRAMEWORK[opts.framework]) args.framework = VERCEL_FRAMEWORK[opts.framework];
      if (opts.buildCommand) args.buildCommand = opts.buildCommand;
      if (opts.outputDirectory) args.outputDirectory = opts.outputDirectory;
      if (opts.envVars) args.envVars = opts.envVars;
      return { tool, args };
    }
    case 'cloudflare': {
      const err = needsGitSource(provider, tool, source);
      if (err) return { tool, error: err };
      const args: Record<string, unknown> = { gitUrl: source };
      if (opts.projectName) args.projectName = opts.projectName;
      if (opts.buildCommand) args.buildCommand = opts.buildCommand;
      if (opts.outputDirectory) args.buildOutputDirectory = opts.outputDirectory;
      if (opts.envVars) args.envVars = opts.envVars;
      return { tool, args };
    }
    case 'digitalocean': {
      const err = needsGitSource(provider, tool, source);
      if (err) return { tool, error: err };
      const args: Record<string, unknown> = {
        name: opts.projectName ?? deriveName(source),
        gitUrl: source,
        isStatic: STATIC_FRAMEWORKS.has(opts.framework),
      };
      if (opts.buildCommand) args.buildCommand = opts.buildCommand;
      if (opts.outputDirectory) args.outputDir = opts.outputDirectory;
      if (opts.envVars) args.envVars = opts.envVars;
      return { tool, args };
    }
    case 'netlify': {
      const err = needsGitSource(provider, tool, source);
      if (err) return { tool, error: err };
      const args: Record<string, unknown> = { gitUrl: source };
      if (opts.projectName) args.siteName = opts.projectName;
      if (opts.buildCommand) args.buildCommand = opts.buildCommand;
      if (opts.outputDirectory) args.publishDirectory = opts.outputDirectory;
      if (opts.envVars) args.envVars = opts.envVars;
      return { tool, args };
    }
    case 'heroku': {
      if (!isTarballUrl(source)) {
        return {
          tool,
          error: `heroku's deploy tool ${tool} builds from a source tarball URL (.tar.gz or .tgz); "${source}" is not one. Pass a tarball URL as source.`,
        };
      }
      if (!opts.projectName) {
        return {
          tool,
          error: `heroku's deploy tool ${tool} deploys to an existing app; pass its name as projectName (herokuCreateApp creates one).`,
        };
      }
      const err = unsupported(provider, tool, opts, ['buildCommand', 'outputDirectory']);
      if (err) return { tool, error: err };
      const args: Record<string, unknown> = { appName: opts.projectName, sourceUrl: source };
      if (opts.envVars) args.configVars = opts.envVars;
      return { tool, args };
    }
    case 'aws': {
      if (isGitUrl(source)) {
        const err = unsupported(provider, tool, opts, ['buildCommand', 'outputDirectory']);
        if (err) return { tool, error: err };
        const args: Record<string, unknown> = {
          appName: opts.projectName ?? deriveName(source),
          repository: source,
        };
        if (opts.envVars) args.environmentVariables = opts.envVars;
        return { tool, args };
      }
      const s3Tool = 'awsDeployS3Site';
      if (opts.framework === 'node' || opts.framework === 'python') {
        return {
          tool: s3Tool,
          error: `aws deploys a local directory as a static site with ${s3Tool}; a ${opts.framework} app needs a Git repository URL for Amplify.`,
        };
      }
      if (!opts.projectName) {
        return {
          tool: s3Tool,
          error: `aws deploys a local directory with ${s3Tool}, which needs an S3 bucket name; pass it as projectName.`,
        };
      }
      const err = unsupported(provider, s3Tool, opts, ['envVars', 'buildCommand']);
      if (err) return { tool: s3Tool, error: err };
      return {
        tool: s3Tool,
        args: {
          bucketName: opts.projectName,
          sourceDir: opts.outputDirectory ? joinPath(source, opts.outputDirectory) : source,
        },
      };
    }
    case 'railway': {
      const repo = githubRepo(source);
      if (!repo) {
        return {
          tool,
          error: `railway's deploy tool ${tool} deploys a GitHub repository ("owner/repo"); "${source}" is not a GitHub URL.`,
        };
      }
      const err = unsupported(provider, tool, opts, ['buildCommand', 'outputDirectory']);
      if (err) return { tool, error: err };
      const args: Record<string, unknown> = { repo, projectName: opts.projectName ?? deriveName(source) };
      if (opts.envVars) args.variables = opts.envVars;
      return { tool, args };
    }
    case 'linode':
      return {
        tool,
        error: `linode's deploy tool ${tool} creates an instance from a StackScript and needs stackscriptId, region, plan, image and rootPass, which siteDeploy does not take. Call ${tool} directly.`,
      };
    case 'flyio':
      return {
        tool,
        error: `Fly.io's deploy tool ${tool} runs a Docker image (appName and image), and siteDeploy takes a Git repository or directory. Build and push an image, then call ${tool} directly.`,
      };
    default:
      return { error: `Unknown cloud provider: ${provider}` };
  }
}

/** Dry-run copy of deploy arguments with environment values replaced by their names. */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const key of ['envVars', 'configVars', 'environmentVariables', 'variables']) {
    if (out[key] && typeof out[key] === 'object') out[key] = Object.keys(out[key] as object);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Registrar calls: the real tools and their arguments               */
/* ------------------------------------------------------------------ */

/** The tools each curated registrar pack registers. */
const REGISTRAR_TOOL_MAP: Record<
  DomainRegistrar,
  { search: string; register?: string; dns: string; dnsRead?: string }
> = {
  porkbun: {
    search: 'porkbunSearchDomain',
    register: 'porkbunRegisterDomain',
    dns: 'porkbunConfigureDns',
  },
  namecheap: {
    search: 'namecheapSearchDomain',
    register: 'namecheapRegisterDomain',
    dns: 'namecheapConfigureDns',
    // namecheapConfigureDns replaces every host record, so the current ones
    // are read first and sent back with the new one.
    dnsRead: 'namecheapGetDnsRecords',
  },
  godaddy: {
    search: 'godaddySearchDomain',
    register: 'godaddyRegisterDomain',
    dns: 'godaddyConfigureDns',
  },
  cloudflare: {
    // Cloudflare's registrar takes transfers only, so siteDeploy never registers there.
    search: 'cfRegGetDomainInfo',
    dns: 'cfRegConfigureDns',
  },
};

const REGISTRANT_REQUIRED: Array<keyof RegistrantContact> = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'address1',
  'city',
  'state',
  'postalCode',
  'country',
];

function searchArgs(registrar: DomainRegistrar, domain: string): Record<string, unknown> {
  return registrar === 'namecheap' ? { domains: domain } : { domain };
}

function isAvailable(data: any, domain: string): boolean {
  const entry = Array.isArray(data)
    ? data.find((d) => String(d?.domain ?? '').toLowerCase() === domain.toLowerCase())
    : data;
  return entry?.available === true || entry?.status === 'available';
}

function registerArgs(
  registrar: DomainRegistrar,
  domain: string,
  registrant?: RegistrantContact,
): { args: Record<string, unknown> } | { error: string } {
  if (registrar === 'porkbun') {
    // Porkbun fills any contact field left out from the account's defaults.
    const args: Record<string, unknown> = { domain, years: 1 };
    if (registrant) {
      const r = registrant;
      Object.assign(args, {
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        phone: r.phone,
        address: r.address2 ? `${r.address1}, ${r.address2}` : r.address1,
        city: r.city,
        state: r.state,
        zip: r.postalCode,
        country: r.country,
      });
      if (r.organization) args.organization = r.organization;
      for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
    }
    return { args };
  }

  const missing = registrant
    ? REGISTRANT_REQUIRED.filter((k) => !registrant[k])
    : REGISTRANT_REQUIRED;
  if (missing.length > 0) {
    return {
      error: `${registrar} registers a domain only with a registrant contact; pass registrant with ${missing.join(', ')}.`,
    };
  }
  const r = registrant as RegistrantContact;

  if (registrar === 'namecheap') {
    const contact: Record<string, unknown> = {
      firstName: r.firstName,
      lastName: r.lastName,
      address1: r.address1,
      city: r.city,
      stateProvince: r.state,
      postalCode: r.postalCode,
      country: r.country,
      phone: r.phone,
      emailAddress: r.email,
    };
    if (r.address2) contact.address2 = r.address2;
    if (r.organization) contact.organizationName = r.organization;
    return { args: { domainName: domain, years: 1, registrant: contact } };
  }

  // godaddy
  const mailing: Record<string, unknown> = {
    address1: r.address1,
    city: r.city,
    state: r.state,
    postalCode: r.postalCode,
    country: r.country,
  };
  if (r.address2) mailing.address2 = r.address2;
  const contact: Record<string, unknown> = {
    nameFirst: r.firstName,
    nameLast: r.lastName,
    email: r.email,
    phone: r.phone,
    addressMailing: mailing,
  };
  if (r.organization) contact.organization = r.organization;
  return { args: { domain, period: 1, contactRegistrant: contact } };
}

/**
 * Arguments for an apex record at each registrar's DNS tool. Root names:
 * Porkbun takes an empty name, Cloudflare the full domain, GoDaddy and
 * Namecheap "@" (each tool's inputSchema says so).
 */
function dnsAddArgs(
  registrar: DomainRegistrar,
  domain: string,
  target: { type: string; content: string },
): Record<string, unknown> {
  switch (registrar) {
    case 'porkbun':
      return { domain, action: 'add', type: target.type, name: '', content: target.content };
    case 'cloudflare':
      return { domain, action: 'add', type: target.type, name: domain, content: target.content };
    case 'godaddy':
      return {
        domain,
        action: 'add',
        records: [{ type: target.type, name: '@', data: target.content }],
      };
    default:
      throw new Error(`No DNS add arguments for ${registrar}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Framework and provider heuristics                                  */
/* ------------------------------------------------------------------ */

/** Framework -> recommended providers (first = primary recommendation). */
const FRAMEWORK_PROVIDER_RECOMMENDATIONS: Record<string, CloudProvider[]> = {
  nextjs: ['vercel', 'netlify', 'railway', 'flyio'],
  react: ['vercel', 'cloudflare', 'netlify'],
  vue: ['vercel', 'cloudflare', 'netlify'],
  svelte: ['vercel', 'cloudflare', 'netlify'],
  astro: ['cloudflare', 'vercel', 'netlify'],
  static: ['cloudflare', 'vercel', 'netlify'],
  node: ['railway', 'heroku', 'flyio', 'digitalocean'],
  python: ['railway', 'heroku', 'flyio', 'digitalocean'],
};

/** Framework detection heuristics: filename pattern -> framework. */
const FRAMEWORK_INDICATORS: Array<{ pattern: string; framework: Framework }> = [
  { pattern: 'next.config', framework: 'nextjs' },
  { pattern: 'nuxt.config', framework: 'vue' },
  { pattern: 'vue.config', framework: 'vue' },
  { pattern: 'vite.config', framework: 'vue' },
  { pattern: 'svelte.config', framework: 'svelte' },
  { pattern: 'astro.config', framework: 'astro' },
  { pattern: 'requirements.txt', framework: 'python' },
  { pattern: 'Pipfile', framework: 'python' },
  { pattern: 'pyproject.toml', framework: 'python' },
  { pattern: 'package.json', framework: 'node' },
  { pattern: 'index.html', framework: 'static' },
];

/* ------------------------------------------------------------------ */
/*  SiteDeployTool                                                     */
/* ------------------------------------------------------------------ */

export class SiteDeployTool {
  readonly id = 'siteDeploy';
  readonly name = 'siteDeploy';
  readonly displayName = 'Deploy Site';
  readonly description =
    'Deploy a site to a supported cloud provider (Vercel, Cloudflare Pages, DigitalOcean, Netlify, ' +
    'AWS Amplify and Railway from a Git repository URL; Heroku from a source tarball URL; AWS S3 from a ' +
    'local directory) with optional custom domain registration and DNS configuration. Linode and Fly.io ' +
    'are refused with the tool to call instead. Auto-detects framework and selects a provider if not specified.';
  readonly category = 'cloud';
  readonly version = '0.1.0';
  readonly hasSideEffects = true;

  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      source: {
        type: 'string',
        description:
          'Git repository URL (Vercel, Cloudflare, DigitalOcean, Netlify, AWS Amplify; a GitHub URL for Railway), a source tarball URL (Heroku), or a local directory path (AWS S3)',
      },
      cloudProvider: {
        type: 'string',
        enum: ['vercel', 'cloudflare', 'digitalocean', 'netlify', 'heroku', 'aws', 'linode', 'railway', 'flyio'],
        description: 'Cloud provider to deploy to (default: auto-detect best fit)',
      },
      projectName: {
        type: 'string',
        description:
          'Project, site or app name on the provider (derived from the source when omitted). Required for Heroku (the existing app) and for a local directory on AWS (the S3 bucket).',
      },
      domain: {
        type: 'string',
        description: 'Custom domain to configure (optional). If not registered, will attempt to register via domainRegistrar.',
      },
      domainRegistrar: {
        type: 'string',
        enum: ['porkbun', 'namecheap', 'godaddy', 'cloudflare'],
        description: 'Domain registrar to use for domain purchase (required if domain is not already registered)',
      },
      registrant: {
        type: 'object',
        description:
          'Registrant contact for a new registration. Required at Namecheap and GoDaddy; Porkbun uses the account defaults when omitted.',
        properties: {
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string', description: 'Phone in +CountryCode.Number form (e.g. "+1.5555550100")' },
          address1: { type: 'string' },
          address2: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string', description: 'State or province' },
          postalCode: { type: 'string' },
          country: { type: 'string', description: 'Two-letter country code (e.g. "US")' },
          organization: { type: 'string' },
        },
        required: ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'state', 'postalCode', 'country'],
      },
      framework: {
        type: 'string',
        enum: ['nextjs', 'react', 'vue', 'svelte', 'astro', 'static', 'node', 'python', 'auto'],
        description: 'Framework/runtime (default: auto-detect)',
      },
      envVars: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Environment variables to set on the deployment',
      },
      buildCommand: {
        type: 'string',
        description: 'Build command override',
      },
      outputDirectory: {
        type: 'string',
        description: 'Output directory override',
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview the deployment plan without executing (default: false)',
      },
    },
    required: ['source'],
  };

  /* -------------------------------------------------------------- */
  /*  Tool executor — set by the orchestrator that loads this ext    */
  /* -------------------------------------------------------------- */

  private toolExecutor?: ToolExecutorFn;

  setToolExecutor(executor: ToolExecutorFn): void {
    this.toolExecutor = executor;
  }

  /* -------------------------------------------------------------- */
  /*  execute()                                                      */
  /* -------------------------------------------------------------- */

  async execute(
    args: SiteDeployInput,
  ): Promise<{ success: boolean; data?: SiteDeployOutput; error?: string }> {
    const steps: DeployStepResult[] = [];
    const dryRun = args.dryRun ?? false;

    try {
      // ── Step 1: Detect framework ─────────────────────────────────
      const framework = this.detectFramework(args.source, args.framework);
      steps.push({
        step: 'detect_framework',
        success: true,
        data: { framework, source: args.source },
      });

      // ── Step 2: Select cloud provider ────────────────────────────
      const provider = this.selectProvider(framework, args.cloudProvider);
      steps.push({
        step: 'select_provider',
        success: true,
        data: { provider, reason: args.cloudProvider ? 'user-specified' : 'auto-selected' },
      });

      const plan = planDeploy(provider, {
        source: args.source,
        framework,
        projectName: args.projectName,
        envVars: args.envVars,
        buildCommand: args.buildCommand,
        outputDirectory: args.outputDirectory,
      });

      // ── Dry run: return the plan ─────────────────────────────────
      if (dryRun) {
        const output: SiteDeployOutput = {
          framework,
          cloudProvider: provider,
          steps,
          domainStatus: args.domain ? 'not_configured' : undefined,
          dnsInstructions: args.domain
            ? [`Would configure ${args.domain} on ${provider} after deployment.`]
            : undefined,
        };

        if (args.domain && args.domainRegistrar) {
          output.dnsInstructions!.push(
            `Would check/register ${args.domain} via ${args.domainRegistrar}.`,
          );
        }

        steps.push({
          step: 'dry_run_plan',
          success: !('error' in plan),
          data: {
            deployTool: plan.tool,
            deployArgs: 'args' in plan ? redactArgs(plan.args) : undefined,
            registrarTools: args.domainRegistrar
              ? REGISTRAR_TOOL_MAP[args.domainRegistrar as DomainRegistrar]
              : undefined,
            envVars: args.envVars ? Object.keys(args.envVars) : [],
            buildCommand: args.buildCommand,
            outputDirectory: args.outputDirectory,
          },
          error: 'error' in plan ? plan.error : undefined,
        });

        if ('error' in plan) {
          return { success: false, data: output, error: plan.error };
        }
        return { success: true, data: output };
      }

      // ── Step 3: Deploy to cloud provider ─────────────────────────
      const deployResult = await this.deployToProvider(provider, plan);

      steps.push({
        step: 'deploy',
        success: deployResult.success,
        data: deployResult.data,
        error: deployResult.error,
      });

      if (!deployResult.success) {
        return {
          success: false,
          data: {
            framework,
            cloudProvider: provider,
            steps,
            domainStatus: 'not_configured',
          },
          error: `Deployment to ${provider} failed: ${deployResult.error}`,
        };
      }

      const deploymentUrl =
        (deployResult.data?.url as string) ??
        (deployResult.data?.deploymentUrl as string) ??
        (deployResult.data?.appUrl as string) ??
        (deployResult.data?.liveUrl as string) ??
        (deployResult.data?.websiteUrl as string);

      // ── Step 4: Domain setup (if requested) ──────────────────────
      let domainStatus: SiteDeployOutput['domainStatus'] = 'not_configured';
      let dnsInstructions: string[] | undefined;

      if (args.domain) {
        const domainResult = await this.setupDomain(
          args.domain,
          args.domainRegistrar as DomainRegistrar | undefined,
          provider,
          deploymentUrl,
          args.registrant,
        );

        domainStatus = domainResult.status;
        dnsInstructions = domainResult.instructions;

        for (const step of domainResult.steps) {
          steps.push(step);
        }
      }

      return {
        success: true,
        data: {
          framework,
          cloudProvider: provider,
          deploymentUrl,
          domainStatus,
          dnsInstructions,
          steps,
        },
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: {
          framework: args.framework ?? 'auto',
          cloudProvider: args.cloudProvider ?? 'auto',
          steps,
        },
        error: message,
      };
    }
  }

  /* -------------------------------------------------------------- */
  /*  Framework detection                                            */
  /* -------------------------------------------------------------- */

  /**
   * Detect the framework from source path heuristics.
   * Falls back to 'static' if nothing matches.
   */
  private detectFramework(source: string, specified?: string): string {
    if (specified && specified !== 'auto') return specified;

    const lowerSource = source.toLowerCase();

    // Check if the source URL or path hints at a framework
    for (const { pattern, framework } of FRAMEWORK_INDICATORS) {
      if (lowerSource.includes(pattern.toLowerCase())) {
        return framework;
      }
    }

    // Heuristic: GitHub URLs often have framework in the name
    if (lowerSource.includes('next')) return 'nextjs';
    if (lowerSource.includes('react') || lowerSource.includes('cra')) return 'react';
    if (lowerSource.includes('vue') || lowerSource.includes('nuxt')) return 'vue';
    if (lowerSource.includes('svelte') || lowerSource.includes('sveltekit')) return 'svelte';
    if (lowerSource.includes('astro')) return 'astro';
    if (lowerSource.includes('flask') || lowerSource.includes('django') || lowerSource.includes('fastapi')) return 'python';

    // Default to static for unknown sources
    return 'static';
  }

  /* -------------------------------------------------------------- */
  /*  Provider selection                                             */
  /* -------------------------------------------------------------- */

  private selectProvider(
    framework: string,
    specified?: CloudProvider,
  ): CloudProvider {
    if (specified) return specified;

    const recommendations = FRAMEWORK_PROVIDER_RECOMMENDATIONS[framework];
    if (recommendations && recommendations.length > 0) {
      return recommendations[0];
    }

    // Fallback: vercel for frontend, railway for backend
    if (framework === 'node' || framework === 'python') return 'railway';
    return 'vercel';
  }

  /* -------------------------------------------------------------- */
  /*  Deployment                                                     */
  /* -------------------------------------------------------------- */

  private async deployToProvider(
    provider: CloudProvider,
    plan: DeployPlan,
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    if ('error' in plan) {
      return { success: false, error: plan.error };
    }

    if (!this.toolExecutor) {
      return {
        success: false,
        error: `No tool executor available. Deploy tool "${plan.tool}" cannot be invoked. Ensure the ${provider} extension is installed.`,
      };
    }

    return this.toolExecutor(plan.tool, plan.args);
  }

  /* -------------------------------------------------------------- */
  /*  Domain setup                                                   */
  /* -------------------------------------------------------------- */

  private async setupDomain(
    domain: string,
    registrar: DomainRegistrar | undefined,
    provider: CloudProvider,
    deploymentUrl?: string,
    registrant?: RegistrantContact,
  ): Promise<{
    status: SiteDeployOutput['domainStatus'];
    instructions?: string[];
    steps: DeployStepResult[];
  }> {
    const steps: DeployStepResult[] = [];
    const instructions: string[] = [];

    if (!this.toolExecutor) {
      steps.push({
        step: 'domain_setup',
        success: false,
        error: 'No tool executor available for domain configuration.',
      });
      return { status: 'not_configured', instructions: ['Domain tools not available. Configure DNS manually.'], steps };
    }

    // ── Check if domain is already configured via registrar ────────
    if (registrar) {
      const registrarTools = REGISTRAR_TOOL_MAP[registrar];
      if (!registrarTools) {
        steps.push({
          step: 'domain_check',
          success: false,
          error: `Unknown registrar: ${registrar}`,
        });
        return { status: 'registration_failed', steps };
      }

      // Search / check domain availability
      try {
        const searchResult = await this.toolExecutor(registrarTools.search, searchArgs(registrar, domain));
        steps.push({
          step: 'domain_search',
          success: searchResult.success,
          data: Array.isArray(searchResult.data) ? { results: searchResult.data } : searchResult.data,
          error: searchResult.error,
        });

        // If the domain is available (not yet registered), try to register it.
        // Cloudflare registrar only supports transfers, not new registrations.
        if (searchResult.success && isAvailable(searchResult.data, domain) && registrarTools.register) {
          const planned = registerArgs(registrar, domain, registrant);
          if ('error' in planned) {
            steps.push({ step: 'domain_register', success: false, error: planned.error });
            instructions.push(
              `Domain registration not attempted: ${planned.error} Or register ${domain} manually and point DNS to your deployment.`,
            );
            return { status: 'registration_failed', instructions, steps };
          }
          try {
            const registerResult = await this.toolExecutor(registrarTools.register, planned.args);
            steps.push({
              step: 'domain_register',
              success: registerResult.success,
              data: registerResult.data,
              error: registerResult.error,
            });

            if (!registerResult.success) {
              instructions.push(
                `Domain registration failed: ${registerResult.error}. Register ${domain} manually and point DNS to your deployment.`,
              );
              return { status: 'registration_failed', instructions, steps };
            }
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            steps.push({
              step: 'domain_register',
              success: false,
              error: message,
            });
            instructions.push(`Domain registration failed: ${message}. Register ${domain} manually.`);
            return { status: 'registration_failed', instructions, steps };
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({
          step: 'domain_search',
          success: false,
          error: message,
        });
        // Continue — domain might already be registered elsewhere
      }

      // ── Configure DNS records ──────────────────────────────────
      const dnsTarget = this.getDnsTarget(provider, deploymentUrl);
      try {
        let dnsArgs: Record<string, unknown>;
        if (registrar === 'namecheap') {
          const built = await this.namecheapDnsArgs(domain, dnsTarget, registrarTools.dnsRead!, steps);
          if ('error' in built) {
            instructions.push(
              `DNS configuration not attempted: ${built.error} Manually add a ${dnsTarget.type} record for ${domain} pointing to ${dnsTarget.content}.`,
            );
            return { status: 'pending_dns', instructions, steps };
          }
          dnsArgs = built.args;
        } else {
          dnsArgs = dnsAddArgs(registrar, domain, dnsTarget);
        }

        const dnsResult = await this.toolExecutor(registrarTools.dns, dnsArgs);

        steps.push({
          step: 'domain_dns',
          success: dnsResult.success,
          data: dnsResult.data,
          error: dnsResult.error,
        });

        if (dnsResult.success) {
          instructions.push(
            `DNS ${dnsTarget.type} record created: ${dnsTarget.name} -> ${dnsTarget.content}`,
          );
          instructions.push('DNS propagation may take up to 48 hours.');
          return { status: 'configured', instructions, steps };
        } else {
          instructions.push(
            `DNS configuration failed: ${dnsResult.error}. Manually add a ${dnsTarget.type} record for ${domain} pointing to ${dnsTarget.content}.`,
          );
          return { status: 'pending_dns', instructions, steps };
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        steps.push({
          step: 'domain_dns',
          success: false,
          error: message,
        });
        instructions.push(`DNS configuration failed: ${message}. Configure DNS manually.`);
        return { status: 'pending_dns', instructions, steps };
      }
    }

    // No registrar specified — provide manual instructions
    const dnsTarget = this.getDnsTarget(provider, deploymentUrl);
    instructions.push(
      `Add a ${dnsTarget.type} record for ${domain} pointing to ${dnsTarget.content} at your DNS provider.`,
    );
    instructions.push('DNS propagation may take up to 48 hours.');
    steps.push({
      step: 'domain_manual_instructions',
      success: true,
      data: { dnsTarget },
    });
    return { status: 'pending_dns', instructions, steps };
  }

  /**
   * namecheapConfigureDns replaces every host record of the domain, so the
   * current records are read first and sent back with the new apex record
   * (an existing apex record of the same type is replaced). A failed read
   * stops here, so the set call never wipes records it could not see.
   */
  private async namecheapDnsArgs(
    domain: string,
    target: { type: string; name: string; content: string },
    readTool: string,
    steps: DeployStepResult[],
  ): Promise<{ args: Record<string, unknown> } | { error: string }> {
    let read: { success: boolean; data?: any; error?: string };
    try {
      read = await this.toolExecutor!(readTool, { domain });
    } catch (err: unknown) {
      read = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const current = read.data?.records;
    if (!read.success || !Array.isArray(current)) {
      const error = `could not read the current Namecheap host records (${read.error ?? 'no records returned'}), and setting records replaces all of them.`;
      steps.push({ step: 'domain_dns_read', success: false, error });
      return { error };
    }
    steps.push({ step: 'domain_dns_read', success: true, data: { records: current.length } });

    const kept = current
      .filter((r) => !(r.name === '@' && String(r.type).toUpperCase() === target.type))
      .map((r) => {
        const entry: Record<string, unknown> = { hostName: r.name, recordType: r.type, address: r.address };
        if (r.mxPref) entry.mxPref = String(r.mxPref);
        if (r.ttl) entry.ttl = String(r.ttl);
        return entry;
      });
    kept.push({ hostName: '@', recordType: target.type, address: target.content });
    return { args: { domain, records: kept } };
  }

  /* -------------------------------------------------------------- */
  /*  DNS target resolution                                          */
  /* -------------------------------------------------------------- */

  /** Determine the appropriate DNS record to create based on the provider. */
  private getDnsTarget(
    provider: CloudProvider,
    deploymentUrl?: string,
  ): { type: string; name: string; content: string } {
    // Extract hostname from deployment URL if available
    let deployHost = '';
    if (deploymentUrl) {
      try {
        deployHost = new URL(
          deploymentUrl.startsWith('http') ? deploymentUrl : `https://${deploymentUrl}`,
        ).hostname;
      } catch {
        deployHost = deploymentUrl;
      }
    }

    // Provider-specific DNS targets
    switch (provider) {
      case 'vercel':
        return { type: 'CNAME', name: '@', content: deployHost || 'cname.vercel-dns.com' };
      case 'cloudflare':
        return { type: 'CNAME', name: '@', content: deployHost || 'pages.dev' };
      case 'netlify':
        return { type: 'CNAME', name: '@', content: deployHost || 'apex-loadbalancer.netlify.com' };
      case 'heroku':
        return { type: 'CNAME', name: '@', content: deployHost || 'dns-target.herokudns.com' };
      case 'railway':
        return { type: 'CNAME', name: '@', content: deployHost || 'railway.app' };
      case 'flyio':
        return { type: 'CNAME', name: '@', content: deployHost || 'fly.dev' };
      case 'digitalocean':
        return { type: 'CNAME', name: '@', content: deployHost || 'ondigitalocean.app' };
      case 'aws':
        return { type: 'CNAME', name: '@', content: deployHost || 'cloudfront.net' };
      case 'linode':
        return { type: 'CNAME', name: '@', content: deployHost || 'nodebalancer.linode.com' };
      default:
        return { type: 'CNAME', name: '@', content: deployHost || 'unknown-provider' };
    }
  }
}
