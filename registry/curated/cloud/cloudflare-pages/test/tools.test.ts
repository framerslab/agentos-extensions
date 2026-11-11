// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CfDeployPagesTool } from '../src/tools/deploy.js';
import { CfListProjectsTool } from '../src/tools/listProjects.js';
import { CfCreateWorkerTool } from '../src/tools/createWorker.js';
import { CfConfigureDnsTool } from '../src/tools/configureDns.js';
import type { CloudflareService } from '../src/CloudflareService.js';

// ---------------------------------------------------------------------------
// Mock service factory
// ---------------------------------------------------------------------------

function createMockService(): CloudflareService {
  return {
    deployFromGit: vi.fn(),
    listProjects: vi.fn(),
    deployWorker: vi.fn(),
    getZoneByDomain: vi.fn(),
    createDnsRecord: vi.fn(),
    deleteDnsRecord: vi.fn(),
    updateDnsRecord: vi.fn(),
    listDnsRecords: vi.fn(),
  } as unknown as CloudflareService;
}

// ---------------------------------------------------------------------------
// CfDeployPagesTool
// ---------------------------------------------------------------------------

describe('CfDeployPagesTool', () => {
  let service: CloudflareService;
  let tool: CfDeployPagesTool;

  beforeEach(() => {
    service = createMockService();
    tool = new CfDeployPagesTool(service);
  });

  it('should have correct id and name', () => {
    expect(tool.id).toBe('cfDeployPages');
    expect(tool.name).toBe('cfDeployPages');
    expect(tool.displayName).toBe('Deploy Cloudflare Pages');
  });

  it('should require gitUrl in inputSchema', () => {
    expect(tool.inputSchema.required).toContain('gitUrl');
  });

  it('should return success on successful deploy', async () => {
    const mockResult = {
      id: 'd1', url: 'https://project.pages.dev', environment: 'production',
      projectName: 'my-project', latestStage: { name: 'deploy', status: 'success' },
    };
    (service.deployFromGit as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const result = await tool.execute({ gitUrl: 'https://github.com/user/repo' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(mockResult);
  });

  it('should forward optional parameters to service', async () => {
    (service.deployFromGit as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await tool.execute({
      gitUrl: 'https://github.com/user/repo',
      projectName: 'repo-staging',
      productionBranch: 'main',
      buildCommand: 'npm run build',
      buildOutputDirectory: 'dist',
      envVars: { API_KEY: 'abc' },
    });

    expect(service.deployFromGit).toHaveBeenCalledWith(
      expect.objectContaining({
        gitUrl: 'https://github.com/user/repo',
        projectName: 'repo-staging',
        productionBranch: 'main',
        buildCommand: 'npm run build',
        buildOutputDirectory: 'dist',
        envVars: { API_KEY: 'abc' },
      }),
    );
  });

  it('should return error on failure', async () => {
    (service.deployFromGit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Token invalid'));

    const result = await tool.execute({ gitUrl: 'https://github.com/user/repo' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Token invalid');
  });
});

// ---------------------------------------------------------------------------
// CfListProjectsTool
// ---------------------------------------------------------------------------

describe('CfListProjectsTool', () => {
  let service: CloudflareService;
  let tool: CfListProjectsTool;

  beforeEach(() => {
    service = createMockService();
    tool = new CfListProjectsTool(service);
  });

  it('should have correct id and name', () => {
    expect(tool.id).toBe('cfListProjects');
    expect(tool.name).toBe('cfListProjects');
  });

  it('should have no required fields', () => {
    expect(tool.inputSchema.required).toHaveLength(0);
  });

  it('should return projects on success', async () => {
    const mockProjects = [{ id: 'p1', name: 'my-site', subdomain: 'my-site.pages.dev' }];
    (service.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue(mockProjects);

    const result = await tool.execute({});

    expect(result.success).toBe(true);
    expect(result.data).toEqual(mockProjects);
    expect(service.listProjects).toHaveBeenCalledWith(25);
  });

  it('should pass custom limit', async () => {
    (service.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await tool.execute({ limit: 10 });

    expect(service.listProjects).toHaveBeenCalledWith(10);
  });

  it('should return error on failure', async () => {
    (service.listProjects as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Rate limited'));

    const result = await tool.execute({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('Rate limited');
  });
});

// ---------------------------------------------------------------------------
// CfCreateWorkerTool
// ---------------------------------------------------------------------------

describe('CfCreateWorkerTool', () => {
  let service: CloudflareService;
  let tool: CfCreateWorkerTool;

  beforeEach(() => {
    service = createMockService();
    tool = new CfCreateWorkerTool(service);
  });

  it('should have correct id and name', () => {
    expect(tool.id).toBe('cfCreateWorker');
    expect(tool.name).toBe('cfCreateWorker');
    expect(tool.displayName).toBe('Deploy Cloudflare Worker');
  });

  it('should require name and script', () => {
    expect(tool.inputSchema.required).toContain('name');
    expect(tool.inputSchema.required).toContain('script');
  });

  it('should return worker on success', async () => {
    const mockWorker = {
      id: 'w1', tag: 'v1', etag: 'abc', size: 1024,
      createdOn: '2024-01-01T00:00:00Z', modifiedOn: '2024-01-01T00:00:00Z',
    };
    (service.deployWorker as ReturnType<typeof vi.fn>).mockResolvedValue(mockWorker);

    const result = await tool.execute({
      name: 'my-worker',
      script: 'export default { fetch() { return new Response("ok"); } }',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(mockWorker);
  });

  it('should forward routes and bindings to service', async () => {
    (service.deployWorker as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await tool.execute({
      name: 'api-worker',
      script: 'export default {}',
      routes: ['example.com/api/*'],
      compatibilityDate: '2024-06-01',
      bindings: { DATABASE_URL: 'postgres://...' },
    });

    expect(service.deployWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'api-worker',
        routes: ['example.com/api/*'],
        compatibilityDate: '2024-06-01',
        bindings: { DATABASE_URL: 'postgres://...' },
      }),
    );
  });

  it('should return error on failure', async () => {
    (service.deployWorker as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Script too large'));

    const result = await tool.execute({ name: 'big-worker', script: '...' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Script too large');
  });
});

// ---------------------------------------------------------------------------
// CfConfigureDnsTool
// ---------------------------------------------------------------------------

describe('CfConfigureDnsTool', () => {
  let service: CloudflareService;
  let tool: CfConfigureDnsTool;

  beforeEach(() => {
    service = createMockService();
    tool = new CfConfigureDnsTool(service);
  });

  it('should have correct id and name', () => {
    expect(tool.id).toBe('cfConfigureDns');
    expect(tool.name).toBe('cfConfigureDns');
  });

  it('should require domain', () => {
    expect(tool.inputSchema.required).toContain('domain');
  });

  it('should list DNS records by default', async () => {
    const mockZone = { id: 'z1', name: 'example.com', status: 'active', nameServers: [] };
    const mockRecords = [{ id: 'r1', type: 'A', name: 'example.com', content: '1.2.3.4', ttl: 1 }];
    (service.getZoneByDomain as ReturnType<typeof vi.fn>).mockResolvedValue(mockZone);
    (service.listDnsRecords as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecords);

    const result = await tool.execute({ domain: 'example.com' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(mockRecords);
  });

  it('should add a DNS record', async () => {
    const mockZone = { id: 'z1', name: 'example.com' };
    const mockRecord = { id: 'r2', type: 'A', name: 'api.example.com', content: '5.6.7.8', ttl: 300 };
    (service.getZoneByDomain as ReturnType<typeof vi.fn>).mockResolvedValue(mockZone);
    (service.createDnsRecord as ReturnType<typeof vi.fn>).mockResolvedValue(mockRecord);

    const result = await tool.execute({
      domain: 'example.com',
      action: 'add',
      recordType: 'A',
      name: 'api.example.com',
      content: '5.6.7.8',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(mockRecord);
  });

  it('should validate required fields for add action', async () => {
    const mockZone = { id: 'z1', name: 'example.com' };
    (service.getZoneByDomain as ReturnType<typeof vi.fn>).mockResolvedValue(mockZone);

    const result = await tool.execute({
      domain: 'example.com',
      action: 'add',
      // Missing recordType, name, content
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('recordType');
  });

  it('should remove a DNS record', async () => {
    const mockZone = { id: 'z1', name: 'example.com' };
    (service.getZoneByDomain as ReturnType<typeof vi.fn>).mockResolvedValue(mockZone);
    (service.deleteDnsRecord as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await tool.execute({
      domain: 'example.com',
      action: 'remove',
      recordId: 'r1',
    });

    expect(result.success).toBe(true);
    expect(service.deleteDnsRecord).toHaveBeenCalledWith('z1', 'r1');
  });

  it('should validate recordId for remove action', async () => {
    const mockZone = { id: 'z1', name: 'example.com' };
    (service.getZoneByDomain as ReturnType<typeof vi.fn>).mockResolvedValue(mockZone);

    const result = await tool.execute({
      domain: 'example.com',
      action: 'remove',
      // Missing recordId
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('recordId');
  });

  it('should update a DNS record', async () => {
    const mockZone = { id: 'z1', name: 'example.com' };
    const updatedRecord = { id: 'r1', type: 'A', name: 'www', content: '9.9.9.9', ttl: 1 };
    (service.getZoneByDomain as ReturnType<typeof vi.fn>).mockResolvedValue(mockZone);
    (service.updateDnsRecord as ReturnType<typeof vi.fn>).mockResolvedValue(updatedRecord);

    const result = await tool.execute({
      domain: 'example.com',
      action: 'update',
      recordId: 'r1',
      content: '9.9.9.9',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(updatedRecord);
  });

  it('should return error on service failure', async () => {
    (service.getZoneByDomain as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Zone not found'));

    const result = await tool.execute({ domain: 'nonexistent.com' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Zone not found');
  });
});
