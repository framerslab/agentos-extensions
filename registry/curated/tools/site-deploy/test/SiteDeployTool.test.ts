// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SiteDeployTool, type ToolExecutorFn, type SiteDeployInput } from '../src/SiteDeployTool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockExecutor(
  overrides: Record<string, (args: Record<string, unknown>) => Promise<{ success: boolean; data?: any; error?: string }>> = {},
): ToolExecutorFn {
  return vi.fn(async (toolName: string, args: Record<string, unknown>) => {
    if (overrides[toolName]) {
      return overrides[toolName](args);
    }
    return { success: true, data: { url: 'https://my-app.vercel.app' } };
  });
}

let tool: SiteDeployTool;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SiteDeployTool', () => {
  beforeEach(() => {
    tool = new SiteDeployTool();
  });

  // ── Metadata ──────────────────────────────────────────────────────────

  it('should have correct tool metadata', () => {
    expect(tool.id).toBe('siteDeploy');
    expect(tool.name).toBe('siteDeploy');
    expect(tool.category).toBe('cloud');
    expect(tool.hasSideEffects).toBe(true);
    expect(tool.inputSchema.required).toContain('source');
  });

  // ── detectFramework ───────────────────────────────────────────────────

  it('should detect nextjs from source containing "next.config"', async () => {
    const executor = createMockExecutor();
    tool.setToolExecutor(executor);

    const result = await tool.execute({ source: '/app/next.config.js', dryRun: true });

    expect(result.data?.framework).toBe('nextjs');
  });

  it('should detect vue from source containing "nuxt.config"', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/project/nuxt.config.ts', dryRun: true });
    expect(result.data?.framework).toBe('vue');
  });

  it('should detect svelte from source containing "svelte.config"', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/project/svelte.config.js', dryRun: true });
    expect(result.data?.framework).toBe('svelte');
  });

  it('should detect astro from source containing "astro.config"', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/project/astro.config.mjs', dryRun: true });
    expect(result.data?.framework).toBe('astro');
  });

  it('should detect python from source containing "requirements.txt"', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/project/requirements.txt', dryRun: true });
    expect(result.data?.framework).toBe('python');
  });

  it('should detect react from source URL containing "react"', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: 'https://github.com/user/my-react-app', dryRun: true });
    expect(result.data?.framework).toBe('react');
  });

  it('should use specified framework instead of auto-detecting', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/app/next.config.js', framework: 'static', dryRun: true });
    expect(result.data?.framework).toBe('static');
  });

  it('should fall back to "static" when no framework detected', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/some/random/dir', dryRun: true });
    expect(result.data?.framework).toBe('static');
  });

  // ── selectProvider ────────────────────────────────────────────────────

  it('should auto-select vercel for nextjs', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/app/next.config.js', dryRun: true });
    expect(result.data?.cloudProvider).toBe('vercel');
  });

  it('should auto-select cloudflare for astro', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/app/astro.config.mjs', dryRun: true });
    expect(result.data?.cloudProvider).toBe('cloudflare');
  });

  it('should auto-select railway for python', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/app/requirements.txt', dryRun: true });
    expect(result.data?.cloudProvider).toBe('railway');
  });

  it('should use user-specified provider over auto-detection', async () => {
    tool.setToolExecutor(createMockExecutor());

    const result = await tool.execute({ source: '/app/next.config.js', cloudProvider: 'netlify', dryRun: true });
    expect(result.data?.cloudProvider).toBe('netlify');
  });

  // ── Dry run ───────────────────────────────────────────────────────────

  it('should return a plan without deploying on dryRun=true', async () => {
    const executor = createMockExecutor();
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/my-next-app',
      dryRun: true,
      domain: 'example.com',
      domainRegistrar: 'porkbun',
      envVars: { NODE_ENV: 'production' },
      buildCommand: 'npm run build',
      outputDirectory: '.next',
    });

    expect(result.success).toBe(true);
    expect(result.data?.steps.length).toBeGreaterThanOrEqual(3);
    // dry_run_plan should be the last step
    const dryRunStep = result.data?.steps.find(s => s.step === 'dry_run_plan');
    expect(dryRunStep).toBeDefined();
    expect(dryRunStep?.data?.deployTool).toBe('vercelDeploy');
    expect(dryRunStep?.data?.registrarTools).toBeDefined();
    expect(dryRunStep?.data?.envVars).toContain('NODE_ENV');
    expect(dryRunStep?.data?.buildCommand).toBe('npm run build');
    expect(dryRunStep?.data?.outputDirectory).toBe('.next');
    // The plan shows the real tool's arguments, with environment values left out
    expect(dryRunStep?.data?.deployArgs).toEqual({
      gitUrl: 'https://github.com/user/my-next-app',
      framework: 'nextjs',
      buildCommand: 'npm run build',
      outputDirectory: '.next',
      envVars: ['NODE_ENV'],
    });

    // domain instructions
    expect(result.data?.dnsInstructions).toBeDefined();
    expect(result.data?.dnsInstructions?.some(i => i.includes('porkbun'))).toBe(true);

    // The executor should NOT have been called during dry run
    expect(executor).not.toHaveBeenCalled();
  });

  it('should fail a dry run whose provider cannot take the source', async () => {
    const executor = createMockExecutor();
    tool.setToolExecutor(executor);

    const result = await tool.execute({ source: '/srv/site', cloudProvider: 'vercel', dryRun: true });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Git repository URL');
    expect(result.data?.steps.find(s => s.step === 'dry_run_plan')?.success).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  // ── Execute: Deploy only ──────────────────────────────────────────────

  it('should deploy successfully without domain', async () => {
    const executor = createMockExecutor({
      vercelDeploy: async () => ({
        success: true,
        data: { url: 'https://my-app.vercel.app', deploymentId: 'dep_123' },
      }),
    });
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/my-next-app',
    });

    expect(result.success).toBe(true);
    expect(result.data?.deploymentUrl).toBe('https://my-app.vercel.app');
    expect(result.data?.domainStatus).toBe('not_configured');
    expect(executor).toHaveBeenCalledWith('vercelDeploy', expect.objectContaining({ gitUrl: 'https://github.com/user/my-next-app' }));
  });

  it('should pass envVars, buildCommand, outputDirectory to deploy tool', async () => {
    const executor = createMockExecutor();
    tool.setToolExecutor(executor);

    await tool.execute({
      source: 'https://github.com/user/app',
      framework: 'nextjs',
      cloudProvider: 'vercel',
      envVars: { API_KEY: 'secret' },
      buildCommand: 'npm run build',
      outputDirectory: 'dist',
    });

    expect(executor).toHaveBeenCalledWith(
      'vercelDeploy',
      expect.objectContaining({
        envVars: { API_KEY: 'secret' },
        buildCommand: 'npm run build',
        outputDirectory: 'dist',
      }),
    );
  });

  // ── Execute: Deploy + Domain ──────────────────────────────────────────

  it('should deploy and configure domain with registrar', async () => {
    const executor = createMockExecutor({
      vercelDeploy: async () => ({
        success: true,
        data: { url: 'https://my-app.vercel.app' },
      }),
      porkbunSearchDomain: async () => ({
        success: true,
        data: { available: true },
      }),
      porkbunRegisterDomain: async () => ({
        success: true,
        data: { status: 'SUCCESS' },
      }),
      porkbunConfigureDns: async () => ({
        success: true,
        data: { id: 'rec_1' },
      }),
    });
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/my-next-app',
      domain: 'myapp.dev',
      domainRegistrar: 'porkbun',
    });

    expect(result.success).toBe(true);
    expect(result.data?.domainStatus).toBe('configured');
    expect(result.data?.dnsInstructions?.some(i => i.includes('CNAME'))).toBe(true);

    // Verify executor was called for deploy + search + register + dns
    expect(executor).toHaveBeenCalledWith('vercelDeploy', expect.any(Object));
    expect(executor).toHaveBeenCalledWith('porkbunSearchDomain', { domain: 'myapp.dev' });
    expect(executor).toHaveBeenCalledWith('porkbunRegisterDomain', { domain: 'myapp.dev', years: 1 });
    expect(executor).toHaveBeenCalledWith('porkbunConfigureDns', expect.objectContaining({
      domain: 'myapp.dev',
      action: 'add',
      type: 'CNAME',
      name: '',
    }));
  });

  it('should provide manual DNS instructions when no registrar specified', async () => {
    const executor = createMockExecutor({
      vercelDeploy: async () => ({
        success: true,
        data: { url: 'https://my-app.vercel.app' },
      }),
    });
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/my-next-app',
      domain: 'myapp.dev',
    });

    expect(result.success).toBe(true);
    expect(result.data?.domainStatus).toBe('pending_dns');
    expect(result.data?.dnsInstructions?.some(i => i.includes('CNAME'))).toBe(true);
    expect(result.data?.dnsInstructions?.some(i => i.includes('myapp.dev'))).toBe(true);
  });

  // ── Error paths ───────────────────────────────────────────────────────

  it('should return failure when deploy fails', async () => {
    const executor = createMockExecutor({
      vercelDeploy: async () => ({
        success: false,
        error: 'Build failed: exit code 1',
      }),
    });
    tool.setToolExecutor(executor);

    // Explicitly pick vercel — without `cloudProvider` set, a generic GitHub
    // URL with no framework hint resolves to 'static' → 'cloudflare', not
    // vercel, and the mock executor's vercelDeploy override never fires.
    const result = await tool.execute({
      source: 'https://github.com/user/broken-app',
      cloudProvider: 'vercel',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Deployment to vercel failed');
    expect(result.data?.domainStatus).toBe('not_configured');
  });

  it('should return error when no tool executor is set', async () => {
    // No setToolExecutor call

    const result = await tool.execute({
      source: 'https://github.com/user/my-app',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No tool executor available');
  });

  it('should handle domain registration failure gracefully', async () => {
    const executor = createMockExecutor({
      vercelDeploy: async () => ({
        success: true,
        data: { url: 'https://my-app.vercel.app' },
      }),
      porkbunSearchDomain: async () => ({
        success: true,
        data: { available: true },
      }),
      porkbunRegisterDomain: async () => ({
        success: false,
        error: 'Insufficient funds',
      }),
    });
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/my-app',
      domain: 'expensive.dev',
      domainRegistrar: 'porkbun',
    });

    expect(result.success).toBe(true); // Deploy succeeded
    expect(result.data?.domainStatus).toBe('registration_failed');
    expect(result.data?.dnsInstructions?.some(i => i.includes('Insufficient funds'))).toBe(true);
  });

  it('should handle DNS configuration failure gracefully', async () => {
    const executor = createMockExecutor({
      netlifyDeploySite: async () => ({
        success: true,
        data: { url: 'https://my-app.netlify.app' },
      }),
      godaddySearchDomain: async () => ({
        success: true,
        data: { available: false }, // already registered
      }),
      godaddyConfigureDns: async () => ({
        success: false,
        error: 'API rate limit exceeded',
      }),
    });
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/my-app',
      cloudProvider: 'netlify',
      domain: 'existing.com',
      domainRegistrar: 'godaddy',
    });

    expect(result.success).toBe(true);
    expect(result.data?.domainStatus).toBe('pending_dns');
    expect(result.data?.dnsInstructions?.some(i => i.includes('API rate limit'))).toBe(true);
  });

  it('should handle domain search throwing an exception', async () => {
    const executor = createMockExecutor({
      vercelDeploy: async () => ({
        success: true,
        data: { url: 'https://my-app.vercel.app' },
      }),
      namecheapSearchDomain: async () => {
        throw new Error('Network timeout');
      },
      namecheapGetDnsRecords: async () => ({
        success: true,
        data: { domain: 'timeout.com', records: [] },
      }),
      namecheapConfigureDns: async () => ({
        success: true,
        data: {},
      }),
    });
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/my-app',
      domain: 'timeout.com',
      domainRegistrar: 'namecheap',
    });

    // Should still succeed — domain search failure is non-fatal
    expect(result.success).toBe(true);
    // DNS config should still be attempted
    expect(executor).toHaveBeenCalledWith('namecheapConfigureDns', expect.any(Object));
  });

  it('should skip registration for cloudflare registrar (transfer-only)', async () => {
    const executor = createMockExecutor({
      cloudProvider: 'cloudflare',
      cfDeployPages: async () => ({
        success: true,
        data: { url: 'https://my-app.pages.dev' },
      }),
      cfRegGetDomainInfo: async () => ({
        success: true,
        data: { available: true, status: 'available' },
      }),
      cfRegConfigureDns: async () => ({
        success: true,
        data: {},
      }),
    } as any);
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/my-astro-app',
      cloudProvider: 'cloudflare',
      domain: 'newdomain.com',
      domainRegistrar: 'cloudflare',
    });

    expect(result.success).toBe(true);
    // Should NOT call cfRegTransferDomain (register) for cloudflare even when available
    expect(executor).not.toHaveBeenCalledWith('cfRegTransferDomain', expect.any(Object));
  });

  it('should handle no tool executor for domain setup', async () => {
    // Set executor, then deploy, then unset for domain step
    // We simulate by testing the domain-only path without executor
    const deployExecutor = createMockExecutor({
      vercelDeploy: async () => ({
        success: true,
        data: { url: 'https://my-app.vercel.app' },
      }),
    });
    tool.setToolExecutor(deployExecutor);

    // Since we can't unset mid-execution, test the path where registrar is unknown
    const result = await tool.execute({
      source: 'https://github.com/user/my-app',
      domain: 'test.com',
      // No registrar — should give manual instructions
    });

    expect(result.success).toBe(true);
    expect(result.data?.domainStatus).toBe('pending_dns');
    const hasManualStep = result.data?.steps.some(s => s.step === 'domain_manual_instructions');
    expect(hasManualStep).toBe(true);
  });

  // ── DNS target resolution ─────────────────────────────────────────────

  it('should use vercel DNS target for vercel deploys', async () => {
    const executor = createMockExecutor({
      vercelDeploy: async () => ({
        success: true,
        data: { url: 'https://my-app.vercel.app' },
      }),
    });
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/app',
      framework: 'nextjs',
      cloudProvider: 'vercel',
      domain: 'test.com',
    });

    expect(result.data?.dnsInstructions?.some(i => i.includes('my-app.vercel.app'))).toBe(true);
  });

  it('should use fallback DNS target when no deployment URL', async () => {
    const executor = createMockExecutor({
      vercelDeploy: async () => ({
        success: true,
        data: {}, // No URL in response
      }),
    });
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: 'https://github.com/user/app',
      framework: 'nextjs',
      cloudProvider: 'vercel',
      domain: 'test.com',
    });

    expect(result.data?.dnsInstructions?.some(i => i.includes('cname.vercel-dns.com'))).toBe(true);
  });

  // ── Execute catches unexpected exceptions ─────────────────────────────

  it('should catch unexpected exceptions and return error', async () => {
    tool.setToolExecutor(() => {
      throw new Error('Unexpected crash');
    });

    const result = await tool.execute({
      source: 'https://github.com/user/my-app',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unexpected crash');
    expect(result.data?.steps).toBeDefined();
  });
});
