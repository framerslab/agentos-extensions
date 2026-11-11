import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PageRefusal, parseRobots, readRobots, robotsAllows, type RobotsRule, type Transport } from '../src/index';
import { stubTransport } from './stub-transport';

// robots.txt as RFC 9309 gives it: the groups by product token, the longest match, `*` and `$`, the parsing limit, and
// what an unavailable or unreachable file means. Every request goes to a stub transport; nothing leaves the process.

const ORIGIN = 'https://pages.example.test';
const RULE: RobotsRule = { token: 'ExampleReader', timeoutMs: 2_000, maxBytes: 512_000, cacheMs: 600_000 };

function allows(text: string, path: string, token = 'ExampleReader'): boolean {
  return robotsAllows(parseRobots(text), token, `${ORIGIN}${path}`);
}

describe('robotsAllows over a parsed robots.txt', () => {
  it('takes the longest matching rule, and an allow over a disallow of the same length', () => {
    const text = ['User-agent: *', 'Disallow: /archive', 'Allow: /archive/public', 'Disallow: /same', 'Allow: /same'].join('\n');
    expect(allows(text, '/archive/2024')).toBe(false);
    expect(allows(text, '/archive/public/a')).toBe(true);
    expect(allows(text, '/same/page')).toBe(true);
    expect(allows(text, '/elsewhere')).toBe(true);
  });

  it('reads `*` as any run of characters and a final `$` as the end of the path', () => {
    const text = ['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /private*/notes', 'Allow: /$', 'Disallow: /'].join('\n');
    expect(allows(text, '/files/report.pdf')).toBe(false);
    expect(allows(text, '/')).toBe(true);
    expect(allows(text, '/anything')).toBe(false);
    const pdfOnly = ['User-agent: *', 'Disallow: /*.pdf$'].join('\n');
    expect(allows(pdfOnly, '/files/report.pdf')).toBe(false);
    expect(allows(pdfOnly, '/files/report.pdf.html')).toBe(true);
    // The query is part of what is matched, so `$` after ".pdf" does not reach a path with a query.
    expect(allows(pdfOnly, '/files/report.pdf?download=1')).toBe(true);
    expect(allows(['User-agent: *', 'Disallow: /private*/notes'].join('\n'), '/private-area/x/notes/1')).toBe(false);
  });

  it('obeys the group of its own token, matched without case, over `*`, and combines two groups of that token', () => {
    const text = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: examplereader',
      'Disallow: /drafts',
      '',
      'User-agent: OtherBot',
      'User-agent: EXAMPLEREADER',
      'Disallow: /tmp',
    ].join('\n');
    expect(allows(text, '/article')).toBe(true);
    expect(allows(text, '/drafts/1')).toBe(false);
    expect(allows(text, '/tmp/1')).toBe(false);
    expect(allows(text, '/article', 'SomeoneElse')).toBe(false);
  });

  it('allows everything with no group for the token and no `*` group, with an empty Disallow, and for /robots.txt itself', () => {
    expect(allows(['User-agent: OtherBot', 'Disallow: /'].join('\n'), '/article')).toBe(true);
    expect(allows(['User-agent: *', 'Disallow:'].join('\n'), '/article')).toBe(true);
    expect(allows(['User-agent: *', 'Disallow: /'].join('\n'), '/robots.txt')).toBe(true);
    expect(allows('', '/article')).toBe(true);
  });

  it('ignores comments, unknown lines and rules before any user-agent, and reads CRLF line ends', () => {
    const text = ['Disallow: /before-any-group', '# a comment', 'User-agent: * # every reader', 'Sitemap: https://pages.example.test/sitemap.xml', 'Crawl-delay: 10', 'Disallow: /cart # no carts'].join('\r\n');
    expect(allows(text, '/before-any-group')).toBe(true);
    expect(allows(text, '/cart/1')).toBe(false);
    expect(allows(text, '/cart-help')).toBe(false);
    expect(allows(text, '/help')).toBe(true);
  });

  it('compares paths with their percent-encoding made one form', () => {
    const text = ['User-agent: *', 'Disallow: /café', 'Disallow: /%7Euser', 'Disallow: /a%2fb'].join('\n');
    expect(allows(text, '/caf%C3%A9/menu')).toBe(false);
    expect(allows(text, '/~user/home')).toBe(false);
    expect(allows(text, '/a%2Fb')).toBe(false);
    expect(allows(text, '/a/b')).toBe(true);
  });

  it('matches a pattern of many wildcards against a long path at once, in the built package', () => {
    // A site writes the pattern; a matcher that backtracks over its wildcards would hold the process for good, past any
    // test timeout, so the built package runs in a child process under a deadline.
    const text = `User-agent: *\nDisallow: /${'*a'.repeat(30)}b$\n`;
    const paths = [`/${'a'.repeat(60)}`, `/${'a'.repeat(60)}b`];
    const dist = new URL('../dist/index.js', import.meta.url).href;
    const script = [
      `import { parseRobots, robotsAllows } from ${JSON.stringify(dist)};`,
      `const file = parseRobots(${JSON.stringify(text)});`,
      `process.stdout.write(JSON.stringify(${JSON.stringify(paths)}.map((path) => robotsAllows(file, 'ExampleReader', 'https://pages.example.test' + path))));`,
    ].join('\n');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5_000 });
    expect(run.signal).toBeNull();
    expect(JSON.parse(run.stdout)).toEqual([true, false]);
    expect(allows(text, paths[0] as string)).toBe(true);
  });

  it('answers the whole file as allowed or refused for the two answers that are no file', () => {
    expect(robotsAllows({ kind: 'allow-all' }, 'ExampleReader', `${ORIGIN}/a`)).toBe(true);
    expect(robotsAllows({ kind: 'disallow-all' }, 'ExampleReader', `${ORIGIN}/a`)).toBe(false);
  });
});

describe('readRobots through a transport', () => {
  it('reads the origin’s /robots.txt once and answers its rules', async () => {
    const stub = stubTransport((url) => (url === `${ORIGIN}/robots.txt` ? { status: 200, body: 'User-agent: *\nDisallow: /private\n', headers: { 'content-type': 'text/plain' } } : undefined));
    const file = await readRobots(`${ORIGIN}/some/page?x=1`, { transport: stub.transport, robots: RULE });
    expect(stub.urls()).toEqual([`${ORIGIN}/robots.txt`]);
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/private/a`)).toBe(false);
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/public/a`)).toBe(true);
  });

  it('allows everything for a 404 and refuses everything for a 503', async () => {
    const missing = stubTransport(() => ({ status: 404, body: 'Not found.' }));
    expect(await readRobots(`${ORIGIN}/a`, { transport: missing.transport, robots: RULE })).toEqual({ kind: 'allow-all' });
    const down = stubTransport(() => ({ status: 503, body: 'Try later.' }));
    const file = await readRobots(`${ORIGIN}/a`, { transport: down.transport, robots: RULE });
    expect(file).toEqual({ kind: 'disallow-all' });
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/a`)).toBe(false);
  });

  it('refuses everything when the request fails, when its own deadline passes, or when the host’s rule refuses a hop of it', async () => {
    const broken = stubTransport(() => new TypeError('connection refused'));
    expect(await readRobots(`${ORIGIN}/a`, { transport: broken.transport, robots: RULE })).toEqual({ kind: 'disallow-all' });

    const stalled: Transport = (_url, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const started = Date.now();
    expect(await readRobots(`${ORIGIN}/a`, { transport: stalled, robots: { ...RULE, timeoutMs: 50 } })).toEqual({ kind: 'disallow-all' });
    expect(Date.now() - started).toBeLessThan(1_500);

    const refused = stubTransport(() => new PageRefusal('refused', 'host'));
    expect(await readRobots(`${ORIGIN}/a`, { transport: refused.transport, robots: RULE })).toEqual({ kind: 'disallow-all' });
  });

  it('allows everything when the file is past five redirects, which RFC 9309 lets a reader take as unavailable', async () => {
    const looping = stubTransport(() => new PageRefusal('redirects'));
    expect(await readRobots(`${ORIGIN}/a`, { transport: looping.transport, robots: RULE })).toEqual({ kind: 'allow-all' });
  });

  it('parses a 600,000-byte file to its first 512,000 bytes and leaves out the line the limit cuts', async () => {
    let text = 'User-agent: *\nDisallow: /early\n';
    const filler = `# ${'x'.repeat(97)}\n`;
    while (text.length + filler.length <= 511_900) text += filler;
    // The line the limit cuts: its first 14 bytes, "Disallow: /str", fall inside the limit.
    text += `${'#'.repeat(512_000 - 14 - text.length - 1)}\n`;
    text += 'Disallow: /straddle\n';
    while (text.length + filler.length <= 599_900) text += filler;
    text += 'Disallow: /late\n';
    text += `${'#'.repeat(600_000 - text.length - 1)}\n`;
    expect(Buffer.byteLength(text)).toBe(600_000);
    expect(text.slice(512_000 - 14, 512_000)).toBe('Disallow: /str');

    const stub = stubTransport(() => ({ status: 200, body: text, headers: { 'content-type': 'text/plain' } }));
    const file = await readRobots(`${ORIGIN}/a`, { transport: stub.transport, robots: RULE });
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/early/1`)).toBe(false);
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/late/1`)).toBe(true);
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/stranger`)).toBe(true);
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/straddle`)).toBe(true);
  });

  it('keeps an origin’s answer for cacheMs on the same transport, and reads it again once that has passed', async () => {
    let clock = 1_000_000;
    const stub = stubTransport(() => ({ status: 200, body: 'User-agent: *\nDisallow: /x\n', headers: { 'content-type': 'text/plain' } }));
    const options = { transport: stub.transport, robots: { ...RULE, cacheMs: 60_000 }, now: () => clock };
    await readRobots(`${ORIGIN}/a`, options);
    await readRobots(`${ORIGIN}/b?q=1`, options);
    expect(stub.urls()).toEqual([`${ORIGIN}/robots.txt`]);
    await readRobots('https://other.example.test/a', options);
    expect(stub.urls()).toEqual([`${ORIGIN}/robots.txt`, 'https://other.example.test/robots.txt']);
    clock += 60_001;
    await readRobots(`${ORIGIN}/c`, options);
    expect(stub.urls()).toHaveLength(3);
  });

  it('keeps an answer for the parsing limit it was read under, so a larger limit reads the file again', async () => {
    const text = `User-agent: *\nDisallow: /early\n${'# filler line\n'.repeat(10)}Disallow: /late\n`;
    const stub = stubTransport(() => ({ status: 200, body: text, headers: { 'content-type': 'text/plain' } }));
    const short = await readRobots(`${ORIGIN}/a`, { transport: stub.transport, robots: { ...RULE, maxBytes: 40 } });
    expect(robotsAllows(short, RULE.token, `${ORIGIN}/late`)).toBe(true);
    const whole = await readRobots(`${ORIGIN}/a`, { transport: stub.transport, robots: RULE });
    expect(robotsAllows(whole, RULE.token, `${ORIGIN}/late`)).toBe(false);
    expect(stub.urls()).toHaveLength(2);
  });

  it('keeps no answer the host’s rule decided, since the next read may be under another rule', async () => {
    let refuse = true;
    const stub = stubTransport(() => (refuse ? new PageRefusal('refused', 'host') : { status: 200, body: 'User-agent: *\nDisallow: /private\n', headers: { 'content-type': 'text/plain' } }));
    expect(await readRobots(`${ORIGIN}/a`, { transport: stub.transport, robots: RULE, allowUrl: () => false })).toEqual({ kind: 'disallow-all' });
    refuse = false;
    const file = await readRobots(`${ORIGIN}/a`, { transport: stub.transport, robots: RULE, allowUrl: () => true });
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/public`)).toBe(true);
    expect(stub.urls()).toHaveLength(2);
  });

  it('throws the caller’s own cancellation and keeps nothing for it', async () => {
    // The first request waits for the signal; the second answers rules under which /a is allowed, which a kept
    // disallow-all would refuse.
    const answers = stubTransport(() => ({ status: 200, body: 'User-agent: *\nDisallow: /x\n', headers: { 'content-type': 'text/plain' } }));
    let calls = 0;
    const transport: Transport = (url, signal, rules) => {
      calls += 1;
      if (calls > 1) return answers.transport(url, signal, rules);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const controller = new AbortController();
    const reading = readRobots(`${ORIGIN}/a`, { transport, robots: RULE, signal: controller.signal });
    controller.abort(new Error('caller stopped'));
    await expect(reading).rejects.toThrow('caller stopped');

    const file = await readRobots(`${ORIGIN}/a`, { transport, robots: RULE });
    expect(calls).toBe(2);
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/a`)).toBe(true);
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/x/1`)).toBe(false);
  });

  it('throws a refusal of the egress policy, the policy’s answer and not the site’s, and keeps nothing for it', async () => {
    let refuse = true;
    const stub = stubTransport(() => (refuse ? new PageRefusal('refused', 'scheme') : { status: 200, body: 'User-agent: *\nDisallow: /x\n', headers: { 'content-type': 'text/plain' } }));
    await expect(readRobots(`${ORIGIN}/a`, { transport: stub.transport, robots: RULE })).rejects.toMatchObject({ name: 'PageRefusal', failure: 'refused', detail: 'scheme' });
    refuse = false;
    const file = await readRobots(`${ORIGIN}/a`, { transport: stub.transport, robots: RULE });
    expect(robotsAllows(file, RULE.token, `${ORIGIN}/a`)).toBe(true);
    expect(stub.urls()).toHaveLength(2);
  });

  it('asks the transport to apply the host rule to the file’s own hops', async () => {
    const allowUrl = (url: string): boolean => !url.includes('blocked');
    const stub = stubTransport(() => ({ status: 404 }));
    await readRobots(`${ORIGIN}/a`, { transport: stub.transport, robots: RULE, allowUrl });
    expect(stub.calls[0]?.rules?.allowUrl).toBe(allowUrl);
    expect(stub.calls[0]?.rules?.robots).toBeUndefined();
  });
});
