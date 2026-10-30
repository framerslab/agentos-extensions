// The Teams join probe: mounted over /app/dist/bot.js in a published bot image, so the image's own entrypoint starts
// PulseAudio and Xvfb as it does for a run, and this program drives that image's Teams adapter and network policy
// through a guest join of the check's own meeting, the Chromium launched as the bot launches it. It keeps a screen and an
// outline of the page every 1.5 s, and the join's outcome or its error with the stack, in /out, so a join that fails
// names the step and the screen it stopped on. The meeting is the workflow's own, with nobody else in it; a link in an
// error's words is written as <link>.
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
  return { where: location.host + location.pathname, title: short(document.title, 80), counts, buttons, inputs, tids, dialogs, atJoin, words: short(document.body?.innerText, 800) };
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
  try {
    const outcome = await adapter.join(page, { meetingUrl, botName: 'SaysHere probe', signedIn: false });
    record('join outcome', { outcome });
  } catch (err) {
    record('join error', { name: err?.name, message: unlink(String(err?.message ?? err)).slice(0, 3_000), stack: unlink(String(err?.stack ?? '')).split('\n').slice(0, 14).join('\n') });
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
