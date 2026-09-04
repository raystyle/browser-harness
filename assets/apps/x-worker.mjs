/**
 * x-worker — the business loop. Runs in rmux session "x-monitor" under the
 * supervisor, drives a DEDICATED daemon (BH_NAME=x-monitor) so capture rounds
 * never race ad-hoc CLI scripts for tab attachment — both daemons may attach
 * the same agent Chrome concurrently.
 *
 * Each round (X_INTERVAL, default 600s): find/navigate the x.com tab → idle
 * gate → optionally foreground (520x200 docked, throttling defeated) →
 * scroll-harvest articles (≤6 beats) → click the "new posts" pill → store to
 * x_tweets.db → heartbeat. The heartbeat ticks during sleep in ≤2s segments:
 * HEARTBEAT_TIMEOUT(120) < INTERVAL(600) once starved a healthy worker into
 * a kill/respawn storm (71 orphan about:blank tabs) — never again.
 */

import { appendFileSync, readFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { importDist, bhHome } from './x-lib.mjs';

process.env.BH_NAME = process.env.BH_NAME ?? 'x-monitor';

const INTERVAL = Number(process.env.X_INTERVAL ?? 600);
const DOCK_W = Number(process.env.X_DOCK_W ?? 520);
const DOCK_H = Number(process.env.X_DOCK_H ?? 200);
const FOREGROUND = (process.env.X_FOREGROUND ?? '1') !== '0';
const IDLE_THRESHOLD = Number(process.env.X_IDLE_THRESHOLD ?? 10);
const IDLE_WAIT = Number(process.env.X_IDLE_WAIT ?? 60);
const WORKSPACE = process.env.BH_BROWSER_WORKSPACE ?? path.join(bhHome(), 'browser-workspace');
const HEARTBEAT = process.env.X_HEARTBEAT ?? path.join(WORKSPACE, 'x_worker.heartbeat');
const DB_PATH = process.env.X_DB ?? path.join(WORKSPACE, 'x_tweets.db');

const sleep = (s) => new Promise(r => setTimeout(r * 1 || r, s * 1000));

// --- page-side extraction (verbatim selectors from the Python original) ----

const EXTRACT = `(() => {
  const out = [];
  for (const t of document.querySelectorAll('article[data-testid="tweet"]')) {
    const n = (t.querySelector('[data-testid="User-Name"]')?.innerText || '');
    const m = n.match(/@([A-Za-z0-9_]+)/);
    out.push({
      name: n.split('\\n')[0].trim(), handle: m ? m[1] : '',
      text: (t.querySelector('[data-testid="tweetText"]')?.innerText || '').trim(),
      time: (t.querySelector('time')?.getAttribute('datetime') || ''),
      link: (t.querySelector('a[href*="/status/"]')?.getAttribute('href') || ''),
    });
  }
  return out;
})()`;

const FIND_PILL = `(() => {
  for (const el of document.querySelectorAll('button, div[role="button"]')) {
    const s = el.innerText || '';
    if (s.length > 0 && s.length < 40 && el.childElementCount <= 3 &&
        /\\u65b0\\u63a8\\u6587|\\u65b0\\u5e16\\u5b50|new posts|new Tweets/i.test(s)) return el;
  }
  return null;
})()`;

const CLICK_PILL = FIND_PILL.replace('return el;', 'el.click(); return el;');

// --- idle gating (Windows: GetLastInputInfo via PowerShell; else always idle) ---

function idleSecondsPs() {
  if (process.platform !== 'win32') return 0; // non-Windows: always allow foreground
  const ps = [
    '$s="[DllImport(\\"user32.dll\\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p); [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }";',
    'Add-Type -MemberDefinition $s -Name U -Namespace W | Out-Null;',
    '$l = New-Object W.U+LASTINPUTINFO; $l.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($l);',
    '[void][W.U]::GetLastInputInfo([ref]$l);',
    '(([Environment]::TickCount - $l.dwTime) % 4294967296) / 1000',
  ].join(' ');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
    const v = Number(String(r.stdout ?? '').trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Wait up to IDLE_WAIT for the user to go idle; false → this round stays background. */
async function waitIdle() {
  const deadline = Date.now() + IDLE_WAIT * 1000;
  for (;;) {
    const idle = idleSecondsPs();
    if (idle !== null && idle >= IDLE_THRESHOLD) return true;
    if (Date.now() >= deadline) {
      const last = idleSecondsPs();
      return last !== null && last >= IDLE_THRESHOLD;
    }
    await sleep(2);
  }
}

// --- heartbeat -------------------------------------------------------------

function tick() {
  const now = new Date();
  try { utimesSync(HEARTBEAT, now, now); } catch { try { appendFileSync(HEARTBEAT, ''); } catch { /* dir missing */ } }
}

async function sleepWithHeartbeat(seconds) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(2, remaining / 1000));
    tick();
  }
}

// --- foreground: docked 520x200, throttling defeated ------------------------

async function foreground(h, targetId) {
  const r = await h.cdp('Browser.getWindowForTarget', { targetId });
  const wid = r.windowId;
  // Chrome applies windowState and bounds as separate steps — do NOT merge.
  await h.cdp('Browser.setWindowBounds', { windowId: wid, bounds: { windowState: 'normal' } });
  const avail = await h.js('JSON.stringify({w:screen.availWidth,h:screen.availHeight,l:screen.availLeft,t:screen.availTop})').then(s => JSON.parse(String(s)));
  const w = Math.min(DOCK_W, avail.w), hgt = Math.min(DOCK_H, avail.h);
  let x = avail.l + avail.w - w;           // bottom-right of the work area…
  let y = avail.t + avail.h - hgt;
  if (avail.t > 0) y = avail.t;            // …unless the taskbar sits on top/left
  if (avail.l > 0) x = avail.l;
  await h.cdp('Browser.setWindowBounds', { windowId: wid, bounds: { left: x, top: y, width: w, height: hgt } });
  await h.cdp('Target.activateTarget', { targetId });
}

async function restoreWindow(h, targetId) {
  try {
    const r = await h.cdp('Browser.getWindowForTarget', { targetId });
    await h.cdp('Browser.setWindowBounds', { windowId: r.windowId, bounds: { windowState: 'minimized' } });
  } catch { /* already gone */ }
}

// --- one capture round -------------------------------------------------------

async function store(sqlite, tweets) {
  const db = sqlite.openDb(DB_PATH);
  try {
    return sqlite.storeTweets(db, tweets.map(t => ({
      author: t.name ?? '', handle: t.handle ?? '', text: t.text ?? '',
      posted_at: t.time ?? '', url: t.link ? `https://x.com${t.link.startsWith('/') ? t.link : '/' + t.link}` : '',
    })));
  } finally { db.close(); }
}

async function round(h) {
  // 1. find or open the x.com tab
  const tabs = await h.list_tabs(false);
  const xtab = tabs.find(t => t.url.includes('x.com'));
  let targetId;
  if (xtab) {
    await h.switch_tab(xtab.targetId, false);
    targetId = xtab.targetId;
  } else {
    targetId = await h.new_tab('https://x.com/home');
  }
  await h.wait_for_load(20);

  // 2. foreground only when hidden + allowed + user idle
  const hidden = (await h.js('document.visibilityState')) === 'hidden';
  let didForeground = false;
  if (hidden && FOREGROUND) {
    if (await waitIdle()) {
      await foreground(h, targetId);
      didForeground = true;
      await sleep(1.5);
    }
  }

  // 3. scroll-harvest, ≤6 beats; stop when the page height stops growing
  let all = [];
  let prevH = 0;
  for (let beat = 0; beat < 6; beat++) {
    const batch = (await h.js(EXTRACT)) ?? [];
    all = all.concat(batch);
    await h.js('window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))');
    await sleep(1);
    const height = await h.js('document.documentElement.scrollHeight');
    if (height === prevH) break;
    prevH = height;
  }

  // 4. back to top; click the "new posts" pill (≤2 tries) and harvest again
  await h.js('window.scrollTo(0, 0)');
  await sleep(1);
  for (let i = 0; i < 2; i++) {
    const found = await h.js(FIND_PILL);
    if (found) {
      await h.js(CLICK_PILL);
      await sleep(2.5);
      all = all.concat((await h.js(EXTRACT)) ?? []);
      break;
    }
    await sleep(3);
  }

  // 5. dedup by link/text and store
  const seen = new Set();
  const unique = all.filter(t => {
    const key = t.link || `${t.name}|${t.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const inserted = await store(await importDist('sqlite.js'), unique);

  // 6. restore
  if (didForeground) await restoreWindow(h, targetId);
  return inserted;
}

// --- main loop ---------------------------------------------------------------

/** The x-monitor daemon's port: registry record is the authority. */
async function daemonPort() {
  if (process.env.BH_PORT) return Number(process.env.BH_PORT);
  const rec = JSON.parse(readFileSync(path.join(bhHome(), 'runtime', 'bh-x-monitor.port'), 'utf8'));
  return rec.port;
}

async function main() {
  const { ensureDaemon } = await importDist('admin.js');
  const { remoteHost } = await importDist('remote.js');
  const { createHelpers } = await importDist('helpers.js');
  await ensureDaemon();
  const h = createHelpers(remoteHost(await daemonPort()));

  tick(); // visible to the supervisor immediately on start
  console.log(`[worker] started (interval=${INTERVAL}s db=${DB_PATH})`);
  for (;;) {
    try {
      const n = await round(h);
      console.log(`[worker] round ok: +${n} new tweets`);
    } catch (e) {
      console.error(`[worker] round error: ${e?.message ?? e}`);
      await sleep(5);
    }
    await sleepWithHeartbeat(INTERVAL);
  }
}

main().then(code => process.exit(code ?? 0), e => { console.error(e); process.exit(1); });
