// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DigitalOceanService } from '../src/DigitalOceanService.js';

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

const TOKEN = 'test-do-token';

function createService() {
  return new DigitalOceanService({
    token: TOKEN,
    baseUrl: 'https://api.digitalocean.com/v2',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DigitalOceanService', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let service: DigitalOceanService;

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
    it('should set isRunning on valid token', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ account: { status: 'active' } }));

      await service.initialize();

      expect(service.isRunning).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.digitalocean.com/v2/account',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${TOKEN}`,
          }),
        }),
      );
    });

    it('should throw on auth failure', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Unauthorized', 401));

      await expect(service.initialize()).rejects.toThrow('DigitalOcean auth failed: 401');
      expect(service.isRunning).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('should set isRunning to false', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ account: {} }));
      await service.initialize();
      await service.shutdown();
      expect(service.isRunning).toBe(false);
    });
  });

  // ── Apps (App Platform) ───────────────────────────────────────────────

  describe('createApp', () => {
    it('should create a service-type app', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        app: {
          id: 'app-1',
          default_ingress: 'https://app-1.ondigitalocean.app',
          live_url: 'https://app-1.ondigitalocean.app',
          spec: {
            name: 'my-service',
            region: 'nyc',
            services: [{
              name: 'my-service',
              git: { repo_clone_url: 'https://github.com/acme/app', branch: 'main' },
              build_command: 'npm run build',
              run_command: 'npm start',
              environment_slug: 'node-js',
              instance_count: 1,
              instance_size_slug: 'basic-xxs',
            }],
          },
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
      }));

      const app = await service.createApp({
        name: 'my-service',
        gitUrl: 'https://github.com/acme/app',
        buildCommand: 'npm run build',
        runCommand: 'npm start',
      });

      expect(app.id).toBe('app-1');
      expect(app.spec.name).toBe('my-service');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.spec.services).toBeDefined();
      expect(body.spec.services[0].instance_size_slug).toBe('basic-xxs');
    });

    it('should create a static-site app when isStatic is true', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        app: {
          id: 'app-2',
          default_ingress: '',
          live_url: '',
          spec: { name: 'static-site', static_sites: [{ name: 'static-site' }] },
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
      }));

      await service.createApp({
        name: 'static-site',
        gitUrl: 'https://github.com/acme/static',
        isStatic: true,
        outputDir: 'dist',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.spec.static_sites).toBeDefined();
      expect(body.spec.static_sites[0].output_dir).toBe('dist');
      expect(body.spec.services).toBeUndefined();
    });

    it('leaves output_dir unset without outputDir so App Platform finds the build folder', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        app: {
          id: 'app-3',
          default_ingress: '',
          live_url: '',
          spec: { name: 'astro-site', static_sites: [{ name: 'astro-site' }] },
          created_at: '2024-01-01',
          updated_at: '2024-01-01',
        },
      }));

      await service.createApp({
        name: 'astro-site',
        gitUrl: 'https://github.com/acme/astro-site',
        isStatic: true,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // App Platform scans _static, dist, public and build when output_dir is not set.
      expect(body.spec.static_sites[0]).not.toHaveProperty('output_dir');
    });

    it('should include env vars when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        app: {
          id: 'app-3', default_ingress: '', live_url: '',
          spec: { name: 'env-app', services: [] },
          created_at: '', updated_at: '',
        },
      }));

      await service.createApp({
        name: 'env-app',
        gitUrl: 'https://github.com/acme/env-app',
        envVars: { API_KEY: 'abc' },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const envs = body.spec.services[0].envs;
      expect(envs).toEqual([
        { key: 'API_KEY', value: 'abc', scope: 'RUN_AND_BUILD_TIME', type: 'GENERAL' },
      ]);
    });
  });

  describe('listApps', () => {
    it('should return mapped apps', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        apps: [
          { id: 'a1', default_ingress: '', live_url: '', spec: { name: 'app1' }, created_at: '', updated_at: '' },
          { id: 'a2', default_ingress: '', live_url: '', spec: { name: 'app2' }, created_at: '', updated_at: '' },
        ],
      }));

      const apps = await service.listApps();
      expect(apps).toHaveLength(2);
    });

    it('should pass page and perPage', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ apps: [] }));

      await service.listApps(2, 10);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('page=2');
      expect(url).toContain('per_page=10');
    });
  });

  describe('getApp', () => {
    it('should return a single mapped app', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        app: { id: 'a1', default_ingress: 'https://a1.do.app', live_url: '', spec: { name: 'my-app' }, created_at: '', updated_at: '' },
      }));

      const app = await service.getApp('a1');
      expect(app.id).toBe('a1');
      expect(app.defaultIngress).toBe('https://a1.do.app');
    });

    it('should throw on error response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Not Found', 404));

      await expect(service.getApp('bad')).rejects.toThrow('DigitalOcean API 404');
    });
  });

  describe('deleteApp', () => {
    it('should send DELETE request', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 204));

      await service.deleteApp('a1');

      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });

    it('should throw on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Forbidden', 403));

      await expect(service.deleteApp('a1')).rejects.toThrow('DigitalOcean API 403');
    });
  });

  describe('createDeployment', () => {
    it('should trigger a deployment', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        deployment: { id: 'dep-1', phase: 'PENDING_BUILD', created_at: '2024-01-01', updated_at: '2024-01-01', cause: 'manual' },
      }));

      const dep = await service.createDeployment('a1');

      expect(dep.id).toBe('dep-1');
      expect(dep.phase).toBe('PENDING_BUILD');
    });

    it('should include force_build when requested', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        deployment: { id: 'dep-2', phase: 'BUILDING', created_at: '', updated_at: '', cause: 'force' },
      }));

      await service.createDeployment('a1', true);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.force_build).toBe(true);
    });
  });

  // ── Droplets ──────────────────────────────────────────────────────────

  describe('createDroplet', () => {
    it('should create a droplet with required fields', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        droplet: {
          id: 12345, name: 'web-1', status: 'new', memory: 1024, vcpus: 1, disk: 25,
          region: { slug: 'nyc1', name: 'New York 1' },
          image: { id: 100, slug: 'ubuntu-24-04-x64', name: 'Ubuntu 24.04' },
          size_slug: 's-1vcpu-1gb',
          networks: { v4: [{ ip_address: '1.2.3.4', type: 'public' }], v6: [] },
          tags: [], created_at: '2024-01-01',
        },
      }));

      const droplet = await service.createDroplet({
        name: 'web-1',
        region: 'nyc1',
        size: 's-1vcpu-1gb',
        image: 'ubuntu-24-04-x64',
      });

      expect(droplet.id).toBe(12345);
      expect(droplet.name).toBe('web-1');
      expect(droplet.networks.v4[0].ipAddress).toBe('1.2.3.4');
    });

    it('should include optional fields', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        droplet: {
          id: 12346, name: 'web-2', status: 'new', memory: 2048, vcpus: 2, disk: 50,
          region: { slug: 'sfo3', name: 'San Francisco 3' },
          image: { id: 101, slug: 'docker-20-04', name: 'Docker' },
          size_slug: 's-2vcpu-4gb',
          networks: { v4: [], v6: [] },
          tags: ['web'], created_at: '2024-01-01',
        },
      }));

      await service.createDroplet({
        name: 'web-2',
        region: 'sfo3',
        size: 's-2vcpu-4gb',
        image: 'docker-20-04',
        sshKeys: ['ssh-key-1'],
        backups: true,
        ipv6: true,
        tags: ['web'],
        userData: '#!/bin/bash\necho hello',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.ssh_keys).toEqual(['ssh-key-1']);
      expect(body.backups).toBe(true);
      expect(body.ipv6).toBe(true);
      expect(body.tags).toEqual(['web']);
      expect(body.user_data).toBe('#!/bin/bash\necho hello');
    });
  });

  describe('listDroplets', () => {
    it('should return mapped droplets', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        droplets: [
          {
            id: 1, name: 'd1', status: 'active', memory: 512, vcpus: 1, disk: 25,
            region: { slug: 'nyc1', name: 'NYC' }, image: { id: 1, slug: 'ubuntu', name: 'Ubuntu' },
            size_slug: 's-1vcpu-1gb', networks: { v4: [], v6: [] }, tags: [], created_at: '',
          },
        ],
      }));

      const droplets = await service.listDroplets();
      expect(droplets).toHaveLength(1);
      expect(droplets[0].status).toBe('active');
    });

    it('should filter by tag when provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ droplets: [] }));

      await service.listDroplets(1, 20, 'web');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('tag_name=web');
    });
  });

  describe('deleteDroplet', () => {
    it('should send DELETE and succeed on 204', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 204));

      await service.deleteDroplet(12345);

      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });

    it('should throw on non-204 error', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Server Error', 500));

      await expect(service.deleteDroplet(12345)).rejects.toThrow('DigitalOcean API 500');
    });
  });

  // ── DNS ───────────────────────────────────────────────────────────────

  describe('listDomains', () => {
    it('should return mapped domains', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        domains: [
          { name: 'example.com', ttl: 1800, zone_file: '$ORIGIN...' },
        ],
      }));

      const domains = await service.listDomains();
      expect(domains).toHaveLength(1);
      expect(domains[0].name).toBe('example.com');
      expect(domains[0].ttl).toBe(1800);
    });
  });

  describe('addDomain', () => {
    it('should add a domain and return it', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        domain: { name: 'newdomain.com', ttl: 1800, zone_file: '' },
      }));

      const domain = await service.addDomain('newdomain.com');
      expect(domain.name).toBe('newdomain.com');
    });
  });

  describe('createDomainRecord', () => {
    it('should create a DNS record', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        domain_record: { id: 100, type: 'A', name: 'api', data: '1.2.3.4', ttl: 1800 },
      }));

      const record = await service.createDomainRecord('example.com', {
        type: 'A', name: 'api', data: '1.2.3.4',
      });

      expect(record.id).toBe(100);
      expect(record.type).toBe('A');
      expect(record.data).toBe('1.2.3.4');
    });
  });

  describe('updateDomainRecord', () => {
    it('should update a DNS record', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        domain_record: { id: 100, type: 'A', name: 'api', data: '5.6.7.8', ttl: 3600 },
      }));

      const record = await service.updateDomainRecord('example.com', 100, {
        data: '5.6.7.8', ttl: 3600,
      });

      expect(record.data).toBe('5.6.7.8');
      expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
    });
  });

  describe('deleteDomainRecord', () => {
    it('should send DELETE and succeed on 204', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({}, 204));

      await service.deleteDomainRecord('example.com', 100);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/domains/example.com/records/100');
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
    });

    it('should throw on error', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse('Bad Request', 400));

      await expect(service.deleteDomainRecord('example.com', 999)).rejects.toThrow(
        'DigitalOcean API 400',
      );
    });
  });
});
