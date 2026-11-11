// @ts-nocheck
/**
 * siteDeploy against the real curated cloud and registrar tools.
 *
 * The executor below resolves every call by name to the tool class the
 * curated pack registers and checks the arguments against that tool's own
 * inputSchema (required keys, known properties, enums, nested objects and
 * array items). A call to a name no pack registers, or with arguments the
 * tool does not accept, is recorded as a violation.
 */
import { describe, it, expect } from 'vitest';
import { SiteDeployTool } from '../src/SiteDeployTool';

import { VercelDeployTool } from '../../../cloud/vercel/src/tools/deploy';
import { CfDeployPagesTool } from '../../../cloud/cloudflare-pages/src/tools/deploy';
import { DOCreateAppTool } from '../../../cloud/digitalocean/src/tools/createApp';
import { NetlifyDeployTool } from '../../../cloud/netlify/src/tools/deploy';
import { HerokuDeployAppTool } from '../../../cloud/heroku/src/tools/deployApp';
import { AWSDeployAmplifyTool } from '../../../cloud/aws/src/tools/deployAmplify';
import { AWSDeployS3SiteTool } from '../../../cloud/aws/src/tools/deployS3Site';
import { LinodeDeployStackScriptTool } from '../../../cloud/linode/src/tools/deployStackScript';
import { RailwayDeployServiceTool } from '../../../cloud/railway/src/tools/deployService';
import { FlyDeployAppTool } from '../../../cloud/flyio/src/tools/deployApp';

import { PorkbunSearchDomainTool } from '../../../domains/porkbun/src/tools/searchDomain';
import { PorkbunRegisterDomainTool } from '../../../domains/porkbun/src/tools/registerDomain';
import { PorkbunConfigureDnsTool } from '../../../domains/porkbun/src/tools/configureDns';
import { NamecheapSearchDomainTool } from '../../../domains/namecheap/src/tools/searchDomain';
import { NamecheapRegisterDomainTool } from '../../../domains/namecheap/src/tools/registerDomain';
import { NamecheapConfigureDnsTool } from '../../../domains/namecheap/src/tools/configureDns';
import { NamecheapGetDnsRecordsTool } from '../../../domains/namecheap/src/tools/getDnsRecords';
import { GoDaddySearchDomainTool } from '../../../domains/godaddy/src/tools/searchDomain';
import { GoDaddyRegisterDomainTool } from '../../../domains/godaddy/src/tools/registerDomain';
import { GoDaddyConfigureDnsTool } from '../../../domains/godaddy/src/tools/configureDns';
import { CfRegGetDomainInfoTool } from '../../../domains/cloudflare-registrar/src/tools/getDomainInfo';
import { CfRegTransferDomainTool } from '../../../domains/cloudflare-registrar/src/tools/transferDomain';
import { CfRegConfigureDnsTool } from '../../../domains/cloudflare-registrar/src/tools/configureDns';

const TOOL_CLASSES = [
  VercelDeployTool,
  CfDeployPagesTool,
  DOCreateAppTool,
  NetlifyDeployTool,
  HerokuDeployAppTool,
  AWSDeployAmplifyTool,
  AWSDeployS3SiteTool,
  LinodeDeployStackScriptTool,
  RailwayDeployServiceTool,
  FlyDeployAppTool,
  PorkbunSearchDomainTool,
  PorkbunRegisterDomainTool,
  PorkbunConfigureDnsTool,
  NamecheapSearchDomainTool,
  NamecheapRegisterDomainTool,
  NamecheapConfigureDnsTool,
  NamecheapGetDnsRecordsTool,
  GoDaddySearchDomainTool,
  GoDaddyRegisterDomainTool,
  GoDaddyConfigureDnsTool,
  CfRegGetDomainInfoTool,
  CfRegTransferDomainTool,
  CfRegConfigureDnsTool,
];

/** Tool name -> inputSchema, as the curated packs register them. */
const REGISTERED: Record<string, any> = Object.fromEntries(
  TOOL_CLASSES.map((Cls) => {
    const tool = new Cls({});
    return [tool.name, tool.inputSchema];
  }),
);

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** Check a value against the subset of JSON Schema the curated tools use. */
function validate(schema: any, value: unknown, path: string, out: string[]): void {
  if (!schema) return;
  if (schema.type && schema.type !== typeOf(value)) {
    out.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    out.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (schema.type === 'object' && value && typeof value === 'object') {
    for (const key of schema.required ?? []) {
      if ((value as any)[key] === undefined) out.push(`${path}.${key}: required`);
    }
    if (schema.properties) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child === undefined) continue;
        if (!(key in schema.properties)) {
          out.push(`${path}.${key}: not a property the tool accepts`);
          continue;
        }
        validate(schema.properties[key], child, `${path}.${key}`, out);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, out));
  }
}

type Reply = { success: boolean; data?: any; error?: string };

function contractExecutor(replies: Record<string, (args: any) => Reply> = {}) {
  const calls: Array<{ tool: string; args: any }> = [];
  const violations: string[] = [];
  const executor = async (toolName: string, args: Record<string, unknown>): Promise<Reply> => {
    calls.push({ tool: toolName, args });
    const schema = REGISTERED[toolName];
    if (!schema) {
      violations.push(`${toolName}: no curated pack registers this tool`);
      return { success: false, error: `unknown tool ${toolName}` };
    }
    validate(schema, args, toolName, violations);
    if (replies[toolName]) return replies[toolName](args);
    return { success: true, data: { url: 'https://site.example.net' } };
  };
  return { executor, calls, violations };
}

const GIT = 'https://github.com/acme/shop';

const REGISTRANT = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.org',
  phone: '+1.5555550100',
  address1: '1 Main St',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
  country: 'US',
};

describe('siteDeploy calls the tools the curated cloud packs register', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['vercel', { source: GIT, envVars: { A: '1' }, buildCommand: 'npm run build', outputDirectory: 'dist' }, 'vercelDeploy'],
    ['cloudflare', { source: GIT, envVars: { A: '1' }, buildCommand: 'npm run build', outputDirectory: 'dist' }, 'cfDeployPages'],
    ['digitalocean', { source: GIT, envVars: { A: '1' }, buildCommand: 'npm run build', outputDirectory: 'dist' }, 'doCreateApp'],
    ['netlify', { source: GIT, envVars: { A: '1' }, buildCommand: 'npm run build', outputDirectory: 'dist' }, 'netlifyDeploySite'],
    ['aws', { source: GIT, envVars: { A: '1' } }, 'awsDeployAmplify'],
    ['railway', { source: GIT, envVars: { A: '1' } }, 'railwayDeployService'],
    ['heroku', { source: 'https://example.org/builds/shop.tar.gz', projectName: 'shop', envVars: { A: '1' } }, 'herokuDeployApp'],
  ];

  it.each(cases)('%s', async (provider, input, expectedTool) => {
    const { executor, calls, violations } = contractExecutor();
    const tool = new SiteDeployTool();
    tool.setToolExecutor(executor);

    const result = await tool.execute({ ...input, cloudProvider: provider } as any);

    expect(violations).toEqual([]);
    expect(calls.map((c) => c.tool)).toEqual([expectedTool]);
    expect(result.success).toBe(true);
  });

  it('deploys a local directory to AWS through the S3 site tool', async () => {
    const { executor, calls, violations } = contractExecutor();
    const tool = new SiteDeployTool();
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: '/srv/shop',
      outputDirectory: 'dist',
      cloudProvider: 'aws',
      projectName: 'shop-site-bucket',
    } as any);

    expect(violations).toEqual([]);
    expect(calls).toEqual([
      { tool: 'awsDeployS3Site', args: { bucketName: 'shop-site-bucket', sourceDir: '/srv/shop/dist' } },
    ]);
    expect(result.success).toBe(true);
  });

  it.each([
    ['vercel', '/srv/shop'],
    ['netlify', './shop'],
    ['railway', 'https://gitlab.com/acme/shop'],
    ['heroku', GIT],
    ['linode', GIT],
    ['flyio', GIT],
  ])('refuses %s for source %s without calling a tool the pack cannot serve', async (provider, source) => {
    const { executor, calls } = contractExecutor();
    const tool = new SiteDeployTool();
    tool.setToolExecutor(executor);

    const result = await tool.execute({ source, cloudProvider: provider } as any);

    expect(calls).toEqual([]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(new RegExp(provider === 'flyio' ? 'Fly' : provider, 'i'));
  });
});

describe('siteDeploy calls the tools the curated registrar packs register', () => {
  it.each(['porkbun', 'namecheap', 'godaddy'])(
    '%s: search, register and DNS calls match the tools',
    async (registrar) => {
      const { executor, calls, violations } = contractExecutor({
        porkbunSearchDomain: () => ({ success: true, data: { domain: 'shop.dev', available: true } }),
        godaddySearchDomain: () => ({ success: true, data: { domain: 'shop.dev', available: true } }),
        namecheapSearchDomain: () => ({
          success: true,
          data: [{ domain: 'shop.dev', available: true, isPremiumName: false }],
        }),
        namecheapGetDnsRecords: () => ({ success: true, data: { domain: 'shop.dev', records: [] } }),
      });
      const tool = new SiteDeployTool();
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        source: GIT,
        cloudProvider: 'vercel',
        domain: 'shop.dev',
        domainRegistrar: registrar,
        registrant: REGISTRANT,
      } as any);

      expect(violations).toEqual([]);
      expect(calls.some((c) => c.tool.endsWith('RegisterDomain'))).toBe(true);
      expect(result.data?.domainStatus).toBe('configured');
    },
  );

  it('cloudflare: DNS call names the record by its full domain', async () => {
    const { executor, calls, violations } = contractExecutor({
      cfRegGetDomainInfo: () => ({ success: true, data: { name: 'shop.dev' } }),
    });
    const tool = new SiteDeployTool();
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: GIT,
      cloudProvider: 'vercel',
      domain: 'shop.dev',
      domainRegistrar: 'cloudflare',
    } as any);

    expect(violations).toEqual([]);
    const dns = calls.find((c) => c.tool === 'cfRegConfigureDns');
    expect(dns?.args).toMatchObject({ domain: 'shop.dev', action: 'add', type: 'CNAME', name: 'shop.dev' });
    expect(result.data?.domainStatus).toBe('configured');
  });

  it('porkbun: the apex record is created with an empty name', async () => {
    const { executor, calls } = contractExecutor({
      porkbunSearchDomain: () => ({ success: true, data: { available: false } }),
    });
    const tool = new SiteDeployTool();
    tool.setToolExecutor(executor);

    await tool.execute({ source: GIT, cloudProvider: 'vercel', domain: 'shop.dev', domainRegistrar: 'porkbun' } as any);

    expect(calls.find((c) => c.tool === 'porkbunConfigureDns')?.args).toMatchObject({ name: '' });
  });

  it('namecheap: keeps the existing host records when it adds the CNAME', async () => {
    const { executor, calls, violations } = contractExecutor({
      namecheapSearchDomain: () => ({ success: true, data: [{ domain: 'shop.dev', available: false }] }),
      namecheapGetDnsRecords: () => ({
        success: true,
        data: {
          domain: 'shop.dev',
          records: [
            { hostId: '1', name: '@', type: 'MX', address: 'mx.mail.example.net', mxPref: '10', ttl: '1800', isActive: true },
            { hostId: '2', name: 'www', type: 'CNAME', address: 'old.example.net', mxPref: '10', ttl: '1800', isActive: true },
          ],
        },
      }),
    });
    const tool = new SiteDeployTool();
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: GIT,
      cloudProvider: 'vercel',
      domain: 'shop.dev',
      domainRegistrar: 'namecheap',
    } as any);

    expect(violations).toEqual([]);
    const set = calls.find((c) => c.tool === 'namecheapConfigureDns');
    expect(set?.args.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostName: '@', recordType: 'MX', address: 'mx.mail.example.net' }),
        expect.objectContaining({ hostName: 'www', recordType: 'CNAME', address: 'old.example.net' }),
        expect.objectContaining({ hostName: '@', recordType: 'CNAME', address: 'site.example.net' }),
      ]),
    );
    expect(set?.args.records).toHaveLength(3);
    expect(result.data?.domainStatus).toBe('configured');
  });

  it('namecheap: never replaces the records when it cannot read them first', async () => {
    const { executor, calls } = contractExecutor({
      namecheapSearchDomain: () => ({ success: true, data: [{ domain: 'shop.dev', available: false }] }),
      namecheapGetDnsRecords: () => ({ success: false, error: 'API timeout' }),
    });
    const tool = new SiteDeployTool();
    tool.setToolExecutor(executor);

    const result = await tool.execute({
      source: GIT,
      cloudProvider: 'vercel',
      domain: 'shop.dev',
      domainRegistrar: 'namecheap',
    } as any);

    expect(calls.some((c) => c.tool === 'namecheapConfigureDns')).toBe(false);
    expect(result.data?.domainStatus).toBe('pending_dns');
  });

  it.each(['namecheap', 'godaddy'])(
    '%s: an available domain without a registrant contact is not sent to the register tool',
    async (registrar) => {
      const { executor, calls } = contractExecutor({
        godaddySearchDomain: () => ({ success: true, data: { available: true } }),
        namecheapSearchDomain: () => ({ success: true, data: [{ domain: 'shop.dev', available: true }] }),
      });
      const tool = new SiteDeployTool();
      tool.setToolExecutor(executor);

      const result = await tool.execute({
        source: GIT,
        cloudProvider: 'vercel',
        domain: 'shop.dev',
        domainRegistrar: registrar,
      } as any);

      expect(calls.some((c) => c.tool.endsWith('RegisterDomain'))).toBe(false);
      expect(result.data?.domainStatus).toBe('registration_failed');
      expect(result.data?.dnsInstructions?.join(' ')).toMatch(/registrant/);
    },
  );
});
