// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareService } from '../src/CloudflareService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

const API_TOKEN = 'test-cf-token';
const ACCOUNT_ID = 'acct_abc123';

function createService() {
  return new CloudflareService({
    apiToken: API_TOKEN,
    accountId: ACCOUNT_ID,
    baseUrl: 'https://api.cloudflare.com/client/v4',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudflareService', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let service: CloudflareService;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    service = createService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── initialize / shutdown ─────────────────────────────────────────────

  describe('initialize', () => {
    it('should set isRunning to true on valid token', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ result: { status: 'active' } }));

      await service.initialize();

      expect(service.isRunning).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/user/tokens/verify'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${API_TOKEN}`,
          }),
        }),
      );
    });

    it('should throw on auth failure', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Bad token', 403));

      await expect(service.initialize()).rejects.toThrow('Cloudflare auth failed: 403');
      expect(service.isRunning).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('should set isRunning to false', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ result: {} }));
      await service.initialize();
      await service.shutdown();
      expect(service.isRunning).toBe(false);
    });
  });

  // ── Pages Projects ────────────────────────────────────────────────────

  describe('listProjects', () => {
    it('should return mapped projects', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: [
          { id: 'p1', name: 'site-a', subdomain: 'site-a.pages.dev', production_branch: 'main', created_on: '2024-01-01', domains: ['site-a.com'] },
        ],
      }));

      const projects = await service.listProjects();

      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('site-a');
      expect(projects[0].subdomain).toBe('site-a.pages.dev');
      expect(projects[0].productionBranch).toBe('main');
    });

    it('should pass per_page limit', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ result: [] }));

      await service.listProjects(10);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('per_page=10');
    });

    it('should handle missing result gracefully', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}));

      const projects = await service.listProjects();
      expect(projects).toEqual([]);
    });
  });

  describe('getProject', () => {
    it('should return a single mapped project', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: {
          id: 'p1', name: 'my-site', production_branch: 'main',
          created_on: '2024-01-01', domains: [],
          source: { type: 'github', config: { owner: 'acme', repo_name: 'my-site', production_branch: 'main' } },
        },
      }));

      const project = await service.getProject('my-site');

      expect(project.id).toBe('p1');
      expect(project.source?.config?.owner).toBe('acme');
    });

    it('should throw on 404', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Not Found', 404));

      await expect(service.getProject('nope')).rejects.toThrow('Cloudflare API 404');
    });
  });

  describe('createProject', () => {
    it('should create a project with build config', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: { id: 'p-new', name: 'new-site', production_branch: 'main', created_on: '2024-02-01', domains: [] },
      }));

      const project = await service.createProject('new-site', {
        buildCommand: 'npm run build',
        buildOutputDirectory: 'dist',
      });

      expect(project.name).toBe('new-site');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.build_config.build_command).toBe('npm run build');
      expect(body.build_config.destination_dir).toBe('dist');
    });

    it('should attach git source when gitUrl is provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: { id: 'p-git', name: 'from-git', production_branch: 'main', created_on: '2024-02-01', domains: [] },
      }));

      await service.createProject('from-git', {
        gitUrl: 'https://github.com/acme/from-git',
        productionBranch: 'develop',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.source.type).toBe('github');
      expect(body.source.config.owner).toBe('acme');
      expect(body.source.config.repo_name).toBe('from-git');
      expect(body.source.config.production_branch).toBe('develop');
    });

    it('should throw for unparseable git URL', async () => {
      await expect(
        service.createProject('bad', { gitUrl: 'ftp://bad-url/repo' }),
      ).rejects.toThrow('Cannot parse git URL');
    });
  });

  // ── Deployments ───────────────────────────────────────────────────────

  describe('createDeployment', () => {
    it('should trigger a deployment and return result', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: {
          id: 'dep-1', url: 'abc123.my-site.pages.dev',
          environment: 'production', project_name: 'my-site',
          latest_stage: { name: 'build', status: 'active' },
        },
      }));

      const deploy = await service.createDeployment('my-site');

      expect(deploy.id).toBe('dep-1');
      expect(deploy.url).toBe('https://abc123.my-site.pages.dev');
      expect(deploy.environment).toBe('production');
    });

    it('should include branch in FormData when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: {
          id: 'dep-2', url: 'preview.pages.dev', environment: 'preview',
          latest_stage: { name: 'queued', status: 'idle' },
        },
      }));

      await service.createDeployment('my-site', { branch: 'feature/test' });

      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.body).toBeInstanceOf(FormData);
    });
  });

  describe('deployFromGit', () => {
    it('should create project if it does not exist and deploy', async () => {
      // getProject -> 404
      mockFetch.mockResolvedValueOnce(mockResponse('Not Found', 404));
      // createProject
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: { id: 'p-auto', name: 'my-repo', production_branch: 'main', created_on: '2024-01-01', domains: [] },
      }));
      // setProjectEnvVars (PATCH)
      mockFetch.mockResolvedValueOnce(mockResponse({ result: {} }));
      // createDeployment
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: {
          id: 'dep-3', url: 'my-repo.pages.dev', environment: 'production',
          latest_stage: { name: 'build', status: 'active' },
        },
      }));

      const result = await service.deployFromGit({
        gitUrl: 'https://github.com/acme/my-repo',
        envVars: { SECRET: 'val' },
      });

      expect(result.id).toBe('dep-3');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('deploys to the project named by projectName, not the one inferred from the repository', async () => {
      // getProject finds the named project
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: { id: 'p-staging', name: 'shop-staging', production_branch: 'main', created_on: '2024-01-01', domains: [] },
      }));
      // createDeployment
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: { id: 'dep-4', url: 'shop-staging.pages.dev', environment: 'production' },
      }));

      const result = await service.deployFromGit({
        gitUrl: 'https://github.com/acme/shop',
        projectName: 'shop-staging',
      });

      const urls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.every((u) => !u.includes('/pages/projects/shop/') && !u.endsWith('/pages/projects/shop'))).toBe(true);
      expect(urls[0]).toContain('/pages/projects/shop-staging');
      expect(urls[1]).toContain('/pages/projects/shop-staging/deployments');
      expect(result.projectName).toBe('shop-staging');
    });
  });

  describe('getDeployment', () => {
    it('should return mapped deployment', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: {
          id: 'dep-1', project_id: 'p1', project_name: 'my-site',
          url: 'https://my-site.pages.dev', environment: 'production',
          created_on: '2024-01-01', modified_on: '2024-01-01',
          latest_stage: { name: 'deploy', status: 'success' },
          stages: [{ name: 'build', status: 'success', started_on: '2024-01-01', ended_on: '2024-01-01' }],
        },
      }));

      const dep = await service.getDeployment('my-site', 'dep-1');

      expect(dep.id).toBe('dep-1');
      expect(dep.latestStage.status).toBe('success');
      expect(dep.stages).toHaveLength(1);
    });
  });

  describe('listDeployments', () => {
    it('should return list of mapped deployments', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: [
          { id: 'd1', project_id: 'p1', project_name: 's', url: 'a.pages.dev', environment: 'production', created_on: '', modified_on: '', latest_stage: { name: 'deploy', status: 'success' }, stages: [] },
        ],
      }));

      const deps = await service.listDeployments('my-site', 5);

      expect(deps).toHaveLength(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('per_page=5');
    });
  });

  // ── DNS ───────────────────────────────────────────────────────────────

  describe('getZoneByDomain', () => {
    it('should return the matching zone', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: [{ id: 'z1', name: 'example.com', status: 'active', name_servers: ['ns1.cf.com'] }],
      }));

      const zone = await service.getZoneByDomain('example.com');

      expect(zone.id).toBe('z1');
      expect(zone.nameServers).toContain('ns1.cf.com');
    });

    it('should throw when no zone found', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ result: [] }));

      await expect(service.getZoneByDomain('unknown.io')).rejects.toThrow(
        'No Cloudflare zone found for domain: unknown.io',
      );
    });
  });

  describe('createDnsRecord', () => {
    it('should create a DNS record and return mapped result', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: { id: 'r1', type: 'A', name: 'api.example.com', content: '1.2.3.4', ttl: 300, proxied: true },
      }));

      const record = await service.createDnsRecord('z1', {
        type: 'A', name: 'api.example.com', content: '1.2.3.4', ttl: 300, proxied: true,
      });

      expect(record.id).toBe('r1');
      expect(record.proxied).toBe(true);
    });
  });

  describe('updateDnsRecord', () => {
    it('should update a DNS record', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: { id: 'r1', type: 'A', name: 'api.example.com', content: '5.6.7.8', ttl: 600, proxied: false },
      }));

      const record = await service.updateDnsRecord('z1', 'r1', { content: '5.6.7.8', ttl: 600 });

      expect(record.content).toBe('5.6.7.8');
      expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
    });
  });

  describe('deleteDnsRecord', () => {
    it('should send DELETE request', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ result: null }));

      await service.deleteDnsRecord('z1', 'r1');

      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  // ── Workers ───────────────────────────────────────────────────────────

  describe('deployWorker', () => {
    it('should upload a worker script and return metadata', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: { id: 'w1', tag: 'v1', etag: 'abc', size: 1024, created_on: '2024-01-01', modified_on: '2024-01-01' },
      }));

      const worker = await service.deployWorker({
        name: 'my-worker',
        script: 'export default { fetch() { return new Response("ok"); } }',
      });

      expect(worker.id).toBe('w1');
      expect(worker.size).toBe(1024);

      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.body).toBeInstanceOf(FormData);
      expect(callArgs.method).toBe('PUT');
    });
  });

  describe('listWorkers', () => {
    it('should return mapped worker list', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        result: [
          { id: 'w1', tag: 't1', etag: 'e1', size: 512, created_on: '2024-01-01', modified_on: '2024-01-01' },
          { id: 'w2', tag: 't2', etag: 'e2', size: 256, created_on: '2024-01-02', modified_on: '2024-01-02' },
        ],
      }));

      const workers = await service.listWorkers();

      expect(workers).toHaveLength(2);
      expect(workers[0].id).toBe('w1');
    });
  });

  describe('deleteWorker', () => {
    it('should send DELETE request for the named worker', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ result: null }));

      await service.deleteWorker('my-worker');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain(`/accounts/${ACCOUNT_ID}/workers/scripts/my-worker`);
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  // ── setProjectEnvVars ────────────────────────────────────────────────

  describe('setProjectEnvVars', () => {
    it('should PATCH project with environment variable map', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ result: {} }));

      await service.setProjectEnvVars('my-site', { API_KEY: 'secret' }, 'production');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.deployment_configs.production.env_vars.API_KEY).toEqual({
        value: 'secret',
        type: 'plain_text',
      });
      expect(mockFetch.mock.calls[0][1].method).toBe('PATCH');
    });
  });
});
