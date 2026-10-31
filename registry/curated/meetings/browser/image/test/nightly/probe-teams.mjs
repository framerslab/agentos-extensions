// The Teams join probe: mounted over /app/dist/bot.js in a published bot image, so the image's own entrypoint starts
// PulseAudio and Xvfb as it does for a run, and this program drives that image's Teams adapter and network policy
// through a guest join of the check's own meeting, the Chromium launched as the bot launches it. It keeps a screen and an
// outline of the page every 1.5 s, and the join's outcome or its error with the stack, in /out, so a join that fails
// names the step and the screen it stopped on. The meeting is the workflow's own, with nobody else in it; a link in an
// error's words is written as <link>.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { SELECTORS, microsoftTeamsAdapter as adapter } from './adapters/microsoft-teams.js';
import { installNetworkPolicy } from './network-policy.js';

const OUT = '/out';
const MAX_SHOTS = 80;
const meetingUrl = process.env.PROBE_URL ?? '';
const steps = [];
const blocked = new Map();
const unlink = (text) => String(text ?? '').split(meetingUrl || '\u0000').join('<link>').replace(/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/\S+/g, '<link>');
const record = (step, data = {}) => {
  const entry = { at: new Date().toISOString(), step, ...data };
  steps.push(entry);
  console.log(unlink(JSON.stringify({ at: entry.at, step })));
};

/** What the page shows, read in the page: the adapter's selectors counted, the shown keys, fields, test ids and dialogs. */
function outlineInPage(selectors) {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const short = (v, n = 60) => (v == null ? undefined : String(v).replace(/\s+/g, ' ').trim().slice(0, n));
  const all = (sel) => {
    try {
      return Array.from(document.querySelectorAll(sel));
    } catch {
      return [];
    }
  };
  const counts = {};
  for (const [key, sel] of Object.entries(selectors)) {
    if (sel.startsWith('xpath=') || sel.startsWith('text=')) continue;
    const css = sel
      .split(',')
      .filter((part) => !part.includes(':has-text('))
      .join(',');
    const els = css ? all(css) : [];
    counts[key] = { n: els.length, shown: els.filter(shown).length };
  }
  const buttons = all('button, [role="button"]')
    .filter(shown)
    .slice(0, 60)
    .map((b) => ({
      tid: b.getAttribute('data-tid') ?? undefined,
      id: b.id || undefined,
      label: short(b.getAttribute('aria-label') || b.innerText, 40),
      disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' || undefined,
    }));
  const inputs = all('input, textarea, [contenteditable="true"]')
    .filter(shown)
    .slice(0, 20)
    .map((i) => ({
      tid: i.getAttribute('data-tid') ?? undefined,
      id: i.id || undefined,
      type: i.getAttribute('type') ?? undefined,
      length: String(i.value ?? i.innerText ?? '').length,
      invalid: i.getAttribute('aria-invalid') ?? undefined,
      disabled: i.disabled || undefined,
    }));
  const radios = all('input[type="radio"]').map((r) => ({ label: r.getAttribute('aria-label') ?? undefined, checked: r.checked, disabled: r.disabled || undefined }));
  const tids = [...new Set(all('[data-tid]').filter(shown).map((e) => e.getAttribute('data-tid')))].slice(0, 200);
  const dialogs = all('[role="dialog"], [role="alertdialog"]')
    .filter(shown)
    .map((d) => short(d.getAttribute('aria-label') || d.innerText, 160));
  const join = document.querySelector('button[data-tid="prejoin-join-button"]');
  let atJoin;
  if (join && shown(join)) {
    const r = join.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    atJoin = top ? { tag: top.tagName.toLowerCase(), tid: top.getAttribute('data-tid') ?? undefined, id: top.id || undefined, inside: join.contains(top) } : null;
  }
  return { where: location.host + location.pathname, title: short(document.title, 80), counts, buttons, inputs, radios, tids, dialogs, atJoin, words: short(document.body?.innerText, 800) };
}

/** The chat pane's items as a tree of tags, ids, test ids, roles and labels, with each element's own short text. */
function itemsInPage() {
  const desc = (e) => {
    let s = e.tagName.toLowerCase();
    if (e.id) s += `#${e.id.slice(0, 40)}`;
    for (const a of ['data-tid', 'data-testid', 'role', 'aria-label', 'data-mid', 'title']) {
      const v = e.getAttribute(a);
      if (v !== null) s += `[${a.replace('data-', '')}=${v.slice(0, 50)}]`;
    }
    const own = Array.from(e.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).join(' ').slice(0, 50);
    return s + (own ? ` "${own}"` : '');
  };
  const walk = (e, d, out) => {
    if (d > 16 || out.length > 90) return;
    for (const c of e.children) {
      out.push(' '.repeat(d) + desc(c));
      walk(c, d + 1, out);
    }
  };
  return Array.from(document.querySelectorAll('[data-tid="chat-pane-item"]')).map((it) => {
    const out = [desc(it)];
    walk(it, 1, out);
    return { text: (it.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160), tree: out };
  });
}

let context;
let page;
let shots = 0;
let ticking = true;

async function shoot(tag) {
  if (!page || shots >= MAX_SHOTS) return;
  shots += 1;
  const n = String(shots).padStart(3, '0');
  await page.screenshot({ path: `${OUT}/${n}-${tag}.png`, timeout: 5_000 }).catch(() => undefined);
  const outline = await page.evaluate(outlineInPage, SELECTORS).catch((err) => ({ error: String(err?.message ?? err).slice(0, 200) }));
  record(`screen ${n} ${tag}`, { outline });
}

try {
  mkdirSync(OUT, { recursive: true });
  context = await chromium.launchPersistentContext('/tmp/profile', {
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-dev-shm-usage', '--window-size=1280,720'],
    viewport: { width: 1280, height: 720 },
    permissions: ['microphone'],
    serviceWorkers: 'block',
    chromiumSandbox: false,
  });
  await installNetworkPolicy(context, adapter, blocked);
  page = context.pages()[0] ?? (await context.newPage());
  page.on('response', (res) => {
    try {
      const req = res.request();
      const u = new URL(res.url());
      if (req.method() === 'GET' && res.status() < 400) return;
      if (!/teams|skype|microsoft|office|live/i.test(u.host)) return;
      const path = u.pathname.split('/').slice(0, 5).join('/').replace(/[0-9a-f-]{24,}/gi, '<id>').replace(/19:[^/]+/g, '<thread>');
      record('response', { method: req.method(), host: u.host, path, status: res.status() });
    } catch {
      // a response read after its page closed
    }
  });
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      const u = new URL(frame.url());
      record('navigated', { where: u.host + u.pathname });
    } catch {
      record('navigated', { where: 'unparsable' });
    }
  });
  const ticker = (async () => {
    while (ticking) {
      await shoot('tick');
      await new Promise((r) => setTimeout(r, 1_500));
    }
  })();
  record('join start', { selectorsVersion: adapter.selectorsVersion, userAgent: await page.evaluate(() => navigator.userAgent) });
  const pulse = (what) => {
    try {
      return execFileSync('pactl', ['list', 'short', what], { encoding: 'utf8', timeout: 5_000 }).trim().split('\n').map((l) => l.split('\t').slice(0, 3).join(' '));
    } catch (err) {
      return [`pactl failed: ${err?.name}`];
    }
  };
  record('pulse before', { sources: pulse('sources'), sinks: pulse('sinks') });
  const step = async (name, fn) => {
    try {
      const value = await fn();
      record(`ok ${name}`, value === undefined ? {} : { value });
      return value;
    } catch (err) {
      record(`failed ${name}`, { name: err?.name, message: unlink(String(err?.message ?? err)).slice(0, 2_500) });
      throw err;
    }
  };
  try {
    await step('goto', () => page.goto(meetingUrl, { waitUntil: 'domcontentloaded' }).then(() => undefined));
    const name = page.locator(SELECTORS.nameInput).first();
    const inBrowser = page.locator(SELECTORS.continueInBrowser).first();
    await step('name or continue', () => name.or(inBrowser).first().waitFor({ timeout: 30_000 }));
    if (await inBrowser.isVisible()) await step('continue click', () => inBrowser.click({ timeout: 15_000 }));
    await step('name wait', () => name.waitFor({ timeout: 30_000 }));
    await step('name fill', () => name.fill('SaysHere probe', { timeout: 15_000 }));
    const without = page.getByRole('button', { name: /continue without audio or video/i }).first();
    const modal = await without.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
    record('device modal', { shown: modal });
    if (modal) {
      await step('continue without audio or video', () => without.click({ timeout: 10_000 }));
      await page.waitForTimeout(1_500);
      await shoot('after-modal');
    }
    const computer = page.getByRole('radio', { name: /^computer audio$/i }).first();
    const radio = await computer.isChecked({ timeout: 3_000 }).catch(() => 'unread');
    record('computer audio checked', { radio });
    if (radio === false) {
      await step('computer audio check', () => computer.check({ timeout: 5_000 }));
      await shoot('after-radio');
    }
    await step('join now', () => page.locator(SELECTORS.joinNow).first().click({ timeout: 30_000 }));
    const lobby = page.locator(SELECTORS.lobbyText).or(page.locator(SELECTORS.lobbyScreen));
    const stage = page.locator(SELECTORS.callStage).filter({ visible: true });
    await step('lobby or call', () => lobby.or(stage).filter({ visible: true }).first().waitFor({ timeout: 30_000 }));
    const inCall = await stage.first().isVisible();
    record('state', { inCall });
    if (!inCall) await step('admitted', () => adapter.waitForCall(page, 60_000));
    await page.waitForTimeout(4_000);
    await shoot('in-call');
    record('pulse in call', { sinkInputs: pulse('sink-inputs'), sourceOutputs: pulse('source-outputs') });
    const items = async (tag) => record(`items ${tag}`, { items: await page.evaluate(itemsInPage).catch((err) => [`read failed: ${err?.name}`]) });
    await page.waitForTimeout(8_000);
    await step('post chat one', () => adapter.postChat(page, 'SaysHere probe one'));
    await items('after one');
    await page.waitForTimeout(6_000);
    await items('one after 6 s');
    await shoot('one-6s');
    const retry = page.getByRole('button', { name: /retry|resend|try again/i }).first();
    if (await retry.isVisible().catch(() => false)) {
      await step('retry one', () => retry.click({ timeout: 5_000 }));
      await page.waitForTimeout(6_000);
      await items('after retry');
      await shoot('after-retry');
    } else record('retry key', { shown: false });
    await page.waitForTimeout(8_000);
    await step('post chat two', () => adapter.postChat(page, 'SaysHere probe two'));
    await page.waitForTimeout(6_000);
    await items('two after 6 s');
    await shoot('two-6s');
    await step('participant count', () => adapter.participantCount(page));
    await step('leave', () => adapter.leave(page));
  } catch {
    // each step recorded its own failure
  }
  await new Promise((r) => setTimeout(r, 12_000));
  ticking = false;
  await ticker;
  await shoot('final');
} catch (err) {
  record('probe error', { name: err?.name, message: unlink(String(err?.message ?? err)).slice(0, 1_000) });
} finally {
  record('blocked', { hosts: [...blocked.entries()] });
  writeFileSync(`${OUT}/probe.json`, unlink(JSON.stringify(steps, null, 2)));
  await context?.close().catch(() => undefined);
}
