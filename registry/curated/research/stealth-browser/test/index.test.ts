// @ts-nocheck
/**
 * @fileoverview Tests for StealthBrowserService (unit only, puppeteer fully mocked).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock puppeteer-extra, stealth plugin, and cheerio ───────────────────

const mockPage = {
  goto: vi.fn(),
  title: vi.fn(),
  content: vi.fn(),
  evaluate: vi.fn(),
  evaluateOnNewDocument: vi.fn(),
  setViewport: vi.fn(),
  setUserAgent: vi.fn(),
  setExtraHTTPHeaders: vi.fn(),
  on: vi.fn(),
  url: vi.fn().mockReturnValue('https://example.com'),
  $: vi.fn(),
  screenshot: vi.fn(),
  viewport: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
  click: vi.fn(),
  type: vi.fn(),
  waitForSelector: vi.fn(),
  waitForNavigation: vi.fn(),
  keyboard: { press: vi.fn() },
  goBack: vi.fn(),
  goForward: vi.fn(),
};

const mockBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn(),
};

const mockPuppeteerExtra = {
  use: vi.fn(),
  launch: vi.fn().mockResolvedValue(mockBrowser),
};

const mockStealthPluginInstance = {};
const mockStealthPluginFactory = vi.fn().mockReturnValue(mockStealthPluginInstance);

vi.mock('puppeteer-extra', () => ({
  default: mockPuppeteerExtra,
}));

vi.mock('puppeteer-extra-plugin-stealth', () => ({
  default: mockStealthPluginFactory,
}));

// Mock cheerio with a basic load implementation
const mockCheerioElements: any[] = [];
const mockCheerio = {
  load: vi.fn().mockImplementation(() => {
    const $ = (selector: string) => ({
      each: (fn: (i: number, el: any) => void) => {
        mockCheerioElements.forEach((el, i) => fn(i, el));
      },
      text: () => '',
      html: () => '',
      attr: () => undefined,
    });
    return $;
  }),
};

vi.mock('cheerio', () => mockCheerio);

// ── Import SUT after mocks ──────────────────────────────────────────────

import { StealthBrowserService } from '../src/StealthBrowserService.js';
import { StealthNavigateTool } from '../src/tools/navigate.js';
import { StealthScrapeTool } from '../src/tools/scrape.js';
import { createExtensionPack } from '../src/index.js';
import { createRequire as createPackageRequire } from 'node:module';

// ── Reset mocks between tests ───────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockCheerioElements.length = 0;
});

// ── StealthBrowserService ───────────────────────────────────────────────

describe('StealthBrowserService', () => {
  describe('initialize', () => {
    it('applies stealth plugin to puppeteer-extra', async () => {
      const service = new StealthBrowserService({ headless: true });
      await service.initialize();

      expect(mockStealthPluginFactory).toHaveBeenCalledOnce();
      expect(mockPuppeteerExtra.use).toHaveBeenCalledWith(mockStealthPluginInstance);
      expect(mockPuppeteerExtra.launch).toHaveBeenCalledOnce();

      // Verify anti-detection args passed to launch
      const launchArgs = mockPuppeteerExtra.launch.mock.calls[0][0];
      expect(launchArgs.args).toContain('--disable-blink-features=AutomationControlled');
      expect(launchArgs.args).toContain('--no-sandbox');
      expect(launchArgs.ignoreDefaultArgs).toContain('--enable-automation');

      await service.close();
    });

    it('does not apply stealth plugin when enableEvasions is false', async () => {
      const service = new StealthBrowserService({ enableEvasions: false });
      await service.initialize();

      expect(mockStealthPluginFactory).not.toHaveBeenCalled();
      expect(mockPuppeteerExtra.use).not.toHaveBeenCalled();

      await service.close();
    });

    it('sets viewport and user agent on page', async () => {
      const service = new StealthBrowserService({
        viewport: { width: 1280, height: 720 },
        userAgent: 'CustomAgent/1.0',
      });
      await service.initialize();

      expect(mockPage.setViewport).toHaveBeenCalledWith({ width: 1280, height: 720 });
      expect(mockPage.setUserAgent).toHaveBeenCalledWith('CustomAgent/1.0');

      await service.close();
    });

    it('does not re-initialize if already initialized', async () => {
      const service = new StealthBrowserService();
      await service.initialize();
      await service.initialize();

      // launch should only be called once
      expect(mockPuppeteerExtra.launch).toHaveBeenCalledOnce();

      await service.close();
    });
  });

  describe('navigate', () => {
    it('returns NavigationResult shape', async () => {
      const service = new StealthBrowserService();

      const mockResponse = { status: vi.fn().mockReturnValue(200) };
      mockPage.goto.mockResolvedValueOnce(mockResponse);
      mockPage.title.mockResolvedValueOnce('Example Domain');
      mockPage.content.mockResolvedValueOnce('<html><body>Hello</body></html>');
      mockPage.evaluate.mockResolvedValueOnce('Hello page text');
      mockPage.url.mockReturnValue('https://example.com/page');

      const result = await service.navigate('https://example.com/page');

      expect(result).toMatchObject({
        url: 'https://example.com/page',
        status: 200,
        title: 'Example Domain',
        html: '<html><body>Hello</body></html>',
        text: 'Hello page text',
      });
      expect(result.loadTime).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.consoleMessages)).toBe(true);

      await service.close();
    });

    it('passes waitFor option to page.goto', async () => {
      const service = new StealthBrowserService();

      const mockResponse = { status: vi.fn().mockReturnValue(200) };
      mockPage.goto.mockResolvedValueOnce(mockResponse);
      mockPage.title.mockResolvedValueOnce('Test');
      mockPage.content.mockResolvedValueOnce('<html></html>');
      mockPage.evaluate.mockResolvedValueOnce('');

      await service.navigate('https://example.com', { waitFor: 'domcontentloaded' });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        expect.objectContaining({ waitUntil: 'domcontentloaded' }),
      );

      await service.close();
    });

    it('returns error result when navigation fails', async () => {
      const service = new StealthBrowserService();

      mockPage.goto.mockRejectedValueOnce(new Error('Navigation timeout'));
      mockPage.title.mockResolvedValueOnce('');
      mockPage.evaluate.mockResolvedValueOnce('');
      mockPage.url.mockReturnValue('https://example.com');

      const result = await service.navigate('https://example.com');

      expect(result.status).toBe(0);
      expect(result.consoleMessages).toContainEqual(
        expect.stringContaining('Navigation failed'),
      );

      await service.close();
    });
  });

  describe('scrape', () => {
    it('returns ScrapeResult shape with selector and elements array', async () => {
      const service = new StealthBrowserService();

      // Set up mock cheerio elements
      mockCheerioElements.push({
        tagName: 'div',
        attribs: { class: 'product', 'data-id': '42' },
      });

      // Override the cheerio load mock for this test with proper element handling
      mockCheerio.load.mockImplementationOnce(() => {
        const $ = (selectorOrEl: any) => {
          if (typeof selectorOrEl === 'string') {
            return {
              each: (fn: (i: number, el: any) => void) => {
                mockCheerioElements.forEach((el, i) => fn(i, el));
              },
            };
          }
          // Wrapping an element
          return {
            text: () => 'Product text',
            html: () => '<span>inner</span>',
            attr: (name: string) => selectorOrEl?.attribs?.[name],
          };
        };
        return $;
      });

      mockPage.content.mockResolvedValueOnce('<html><div class="product">stuff</div></html>');

      const result = await service.scrape('.product');

      expect(result).toHaveProperty('selector', '.product');
      expect(result).toHaveProperty('count');
      expect(result).toHaveProperty('elements');
      expect(Array.isArray(result.elements)).toBe(true);

      await service.close();
    });

    it('returns empty result on error', async () => {
      const service = new StealthBrowserService();

      mockPage.content.mockRejectedValueOnce(new Error('Page detached'));

      const result = await service.scrape('.nonexistent');

      expect(result.count).toBe(0);
      expect(result.elements).toEqual([]);

      await service.close();
    });
  });

  describe('user agent rotation', () => {
    it('selects a user agent from the pool when not specified', async () => {
      const service = new StealthBrowserService({});
      await service.initialize();

      expect(mockPage.setUserAgent).toHaveBeenCalledOnce();
      const ua = mockPage.setUserAgent.mock.calls[0][0] as string;

      // Should be one of the Chrome UA strings
      expect(ua).toContain('Chrome/');
      expect(ua).toContain('AppleWebKit');

      await service.close();
    });

    it('uses custom user agent when specified', async () => {
      const customUA = 'MyBot/1.0';
      const service = new StealthBrowserService({ userAgent: customUA });
      await service.initialize();

      expect(mockPage.setUserAgent).toHaveBeenCalledWith(customUA);

      await service.close();
    });

    it('different instances can get different user agents (random selection)', async () => {
      // Since Math.random is used, we create multiple instances
      // and verify they all get valid UAs
      const agents: string[] = [];

      for (let i = 0; i < 5; i++) {
        mockPage.setUserAgent.mockClear();
        mockPuppeteerExtra.launch.mockClear();
        mockBrowser.newPage.mockClear();

        const service = new StealthBrowserService({});
        // Force browser to null so it re-initializes
        (service as any).browser = null;
        (service as any).stealthInitialized = true; // Skip stealth init after first

        await service.initialize();
        agents.push(mockPage.setUserAgent.mock.calls[0][0] as string);
        await service.close();
      }

      // All should be valid Chrome UAs
      for (const ua of agents) {
        expect(ua).toContain('Chrome/');
      }
    });
  });

  describe('close', () => {
    it('closes browser and nullifies references', async () => {
      const service = new StealthBrowserService();
      await service.initialize();
      await service.close();

      expect(mockBrowser.close).toHaveBeenCalledOnce();
      expect((service as any).browser).toBeNull();
      expect((service as any).page).toBeNull();
    });

    it('does nothing when browser not initialized', async () => {
      const service = new StealthBrowserService();
      await service.close(); // Should not throw
      expect(mockBrowser.close).not.toHaveBeenCalled();
    });
  });
});

// ── Tool name constants ─────────────────────────────────────────────────

describe('Tool name constants', () => {
  it('StealthNavigateTool has correct name and id', () => {
    const service = new StealthBrowserService();
    const tool = new StealthNavigateTool(service);
    expect(tool.name).toBe('stealth_navigate');
    expect(tool.id).toBe('stealth-browser-navigate-v1');
    expect(tool.category).toBe('research');
  });

  it('StealthScrapeTool has correct name and id', () => {
    const service = new StealthBrowserService();
    const tool = new StealthScrapeTool(service);
    expect(tool.name).toBe('stealth_scrape');
    expect(tool.id).toBe('stealth-browser-scrape-v1');
    expect(tool.category).toBe('research');
  });
});

// ── Extension pack ──────────────────────────────────────────────────────

describe('createExtensionPack', () => {
  it('creates pack with 6 tool descriptors', () => {
    const pack = createExtensionPack({ options: {} });

    expect(pack.name).toBe('@framers/agentos-ext-stealth-browser');
    expect(pack.version).toBe(createPackageRequire(import.meta.url)('../package.json').version);
    expect(pack.descriptors).toHaveLength(6);

    const toolNames = pack.descriptors.map((d: any) => d.id);
    expect(toolNames).toContain('stealth_navigate');
    expect(toolNames).toContain('stealth_scrape');
    expect(toolNames).toContain('stealth_click');
    expect(toolNames).toContain('stealth_type');
    expect(toolNames).toContain('stealth_screenshot');
    expect(toolNames).toContain('stealth_snapshot');
  });

  it('all descriptors have kind "tool"', () => {
    const pack = createExtensionPack({ options: {} });

    for (const descriptor of pack.descriptors) {
      expect((descriptor as any).kind).toBe('tool');
    }
  });

  it('each tool payload has required ITool properties', () => {
    const pack = createExtensionPack({ options: {} });

    for (const descriptor of pack.descriptors) {
      const tool = (descriptor as any).payload;
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool).toHaveProperty('execute');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('onDeactivate closes the browser service', async () => {
    const pack = createExtensionPack({ options: {} });
    // onDeactivate should call browserService.close() internally
    await expect(pack.onDeactivate()).resolves.toBeUndefined();
  });

  it('uses custom priority when provided', () => {
    const pack = createExtensionPack({ options: { priority: 99 } });

    for (const descriptor of pack.descriptors) {
      expect((descriptor as any).priority).toBe(99);
    }
  });
});
