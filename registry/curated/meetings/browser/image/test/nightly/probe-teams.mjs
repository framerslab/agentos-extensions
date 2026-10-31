// The Teams join probe: mounted over /app/dist/bot.js in a published bot image, so the image's own entrypoint starts
// PulseAudio and Xvfb as it does for a run, and this program drives that image's Teams adapter and network policy
// through guest joins of the check's own meeting, the Chromium launched as the bot launches it, once for each name in
// PROBE_NAMES (a JSON list), each in a browser of its own. It keeps a screen and an outline of the page every 1.5 s, and
// each join's outcome or its error, in /out, so a join that fails names the step and the screen it stopped on. The
// meeting is the workflow's own, with nobody else in it; a link in an error's words is written as <link>.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { SELECTORS, microsoftTeamsAdapter as adapter } from './adapters/microsoft-teams.js';
import { installNetworkPolicy } from './network-policy.js';

const OUT = '/out';
const MAX_SHOTS = 160;
const names = (() => {
  try {
    const list = JSON.parse(process.env.PROBE_NAMES ?? '[]');
    return Array.isArray(list) && list.length > 0 ? list.map(String) : ['SaysHere probe'];
  } catch {
    return ['SaysHere probe'];
  }
})();
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
  const field = document.querySelector('[data-tid="prejoin-display-name-input"]');
  const described = field ? (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => short(document.getElementById(id)?.innerText, 120)) : undefined;
  const nameField = field ? { length: String(field.value ?? '').length, invalid: field.getAttribute('aria-invalid') ?? undefined, required: field.required || undefined, maxLength: field.maxLength, described, alerts: all('[role="alert"]').filter(shown).map((a) => short(a.innerText, 120)) } : undefined;
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
  return { where: location.host + location.pathname, title: short(document.title, 80), counts, buttons, inputs, nameField, radios, tids, dialogs, atJoin, words: short(document.body?.innerText, 800) };
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
let label = 'n1';

async function shoot(tag) {
  if (!page || shots >= MAX_SHOTS) return;
  shots += 1;
  const n = String(shots).padStart(3, '0');
  await page.screenshot({ path: `${OUT}/${n}-${label}-${tag}.jpg`, type: 'jpeg', quality: 45, timeout: 5_000 }).catch(() => undefined);
  const outline = await page.evaluate(outlineInPage, SELECTORS).catch((err) => ({ error: String(err?.message ?? err).slice(0, 200) }));
  record(`screen ${n} ${label} ${tag}`, { outline });
}

const pulse = (what) => {
  try {
    return execFileSync('pactl', ['list', 'short', what], { encoding: 'utf8', timeout: 5_000 }).trim().split('\n').map((l) => l.split('\t').slice(0, 3).join(' '));
  } catch (err) {
    return [`pactl failed: ${err?.name}`];
  }
};

/** One guest join under one name, in a browser of its own: the adapter's join, then the call's screen and Leave. */
async function probeName(botName, index) {
  label = `n${index + 1}`;
  const blocked = new Map();
  let ticking = true;
  let ticker;
  try {
    context = await chromium.launchPersistentContext(`/tmp/profile-${index + 1}`, {
      headless: false,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-dev-shm-usage', '--window-size=1280,720'],
      viewport: { width: 1280, height: 720 },
      permissions: ['microphone'],
      serviceWorkers: 'block',
      chromiumSandbox: false,
    });
    await installNetworkPolicy(context, adapter, blocked);
    page = context.pages()[0] ?? (await context.newPage());
    page.on('requestfailed', (req) => {
      try {
        const u = new URL(req.url());
        record('request failed', { name: label, host: u.host, type: req.resourceType(), failure: req.failure()?.errorText });
      } catch {
        // a request read after its page closed
      }
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        const u = new URL(frame.url());
        record('navigated', { name: label, where: u.host + u.pathname });
      } catch {
        record('navigated', { name: label, where: 'unparsable' });
      }
    });
    ticker = (async () => {
      while (ticking) {
        await shoot('tick');
        await new Promise((r) => setTimeout(r, 1_500));
      }
    })();
    record('join start', { name: label, botName, length: botName.length, selectorsVersion: adapter.selectorsVersion });
    try {
      const outcome = await adapter.join(page, { meetingUrl, botName, signedIn: false });
      record('joined', { name: label, outcome });
      if (outcome?.state === 'waiting_room') {
        await adapter.waitForCall(page, 30_000).then(
          () => record('admitted', { name: label }),
          (err) => record('not admitted', { name: label, message: String(err?.message ?? err).slice(0, 300) }),
        );
      }
      await page.waitForTimeout(3_000);
      await shoot('in-call');
      await adapter.leave(page).then(
        () => record('left', { name: label }),
        (err) => record('leave failed', { name: label, message: String(err?.message ?? err).slice(0, 300) }),
      );
    } catch (err) {
      await shoot('failed');
      record('join failed', { name: label, code: err?.message ? unlink(String(err.message)).slice(0, 600) : String(err), outline: err?.outline });
    }
    await page.waitForTimeout(3_000);
  } catch (err) {
    record('probe error', { name: label, error: err?.name, message: unlink(String(err?.message ?? err)).slice(0, 1_000) });
  } finally {
    ticking = false;
    await ticker?.catch(() => undefined);
    record('blocked', { name: label, hosts: [...blocked.entries()] });
    await context?.close().catch(() => undefined);
    context = undefined;
    page = undefined;
  }
}

mkdirSync(OUT, { recursive: true });
record('pulse', { sources: pulse('sources'), sinks: pulse('sinks') });
for (const [index, botName] of names.entries()) await probeName(botName, index);
writeFileSync(`${OUT}/probe.json`, unlink(JSON.stringify(steps, null, 2)));
