/**
 * x-worker — the business loop. Runs in rmux session "x-monitor";
 * supervisor-core heals the session. Drives a DEDICATED daemon
 * (BH_NAME=x-intel) attached to the USER's browser (D11: never spawn,
 * never reshape/close windows, never touch a tab the user is reading).
 *
 * Trigger: poll every 5s for the x.com "N new posts" indicator; the moment a
 * count shows, a harvest round fires (X_INTERVAL is only the fallback cap).
 * Round: find the x.com tab (defer if the user is actively reading it) →
 * scroll-harvest articles (≤6 beats) → click the pill → store to x_tweets.db.
 * The heartbeat ticks during waits in ≤2s segments so the supervisor can
 * always tell a live worker from a dead one.
 */

import { appendFileSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { importDist, bhHome, dataDir } from './lib.mjs';

process.env.BH_NAME = process.env.BH_NAME ?? 'x-intel';
// The x-intel daemon's working surface is the USER's existing x.com tab:
// attach-first, never create a new tab for it (the daemon inherits this env
// through ensureDaemon's spawn).
process.env.BH_ATTACH_URL_MATCH = process.env.BH_ATTACH_URL_MATCH ?? 'x.com';

const INTERVAL = Number(process.env.X_INTERVAL ?? 600);
const IDLE_THRESHOLD = Number(process.env.X_IDLE_THRESHOLD ?? 10);
const WORKSPACE = process.env.BH_BROWSER_WORKSPACE ?? path.join(bhHome(), 'browser-workspace');
const DATA = dataDir();
const HEARTBEAT = process.env.X_HEARTBEAT ?? path.join(DATA, 'x_worker.heartbeat');
// Guardian status contract (G002): one uniform schema every resident app
// publishes — the dashboard's 应用监控台 renders it with ONE template.
const STATUS = process.env.X_STATUS ?? path.join(DATA, 'x-intel.status.json');
function writeStatus(st) {
  try { writeFileSync(STATUS, JSON.stringify({ _v: '1.0.0', ts: new Date().toISOString(), ...st })); } catch { /* best-effort */ }
}
const DB_PATH = process.env.X_DB ?? path.join(DATA, 'x_tweets.db');

/** @param {number} s */
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

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

// Click the pill's own button (testid-anchored), keyword scan as fallback.
const FIND_PILL = `(() => {
  if (document.querySelector('[data-testid="pillLabel"]')) return true;
  for (const el of document.querySelectorAll('button, div[role="button"]')) {
    const s = el.innerText || '';
    if (s.length > 0 && s.length < 40 && el.childElementCount <= 6 &&
        /(\\u65b0\\u5e16|\\u65b0\\u63a8\\u6587|new posts|new Tweets|\\u663e\\u793a)/i.test(s)) return true;
  }
  return false;
})()`;

const CLICK_PILL = `(() => {
  const label = document.querySelector('[data-testid="pillLabel"]');
  const btn = label && (label.closest('button') || label.closest('div[role="button"]'));
  if (btn) { btn.click(); return true; }
  for (const el of document.querySelectorAll('button, div[role="button"]')) {
    const s = el.innerText || '';
    if (s.length > 0 && s.length < 40 && el.childElementCount <= 6 &&
        /(\\u65b0\\u5e16|\\u65b0\\u63a8\\u6587|new posts|new Tweets|\\u663e\\u793a)/i.test(s)) { el.click(); return true; }
  }
  return false;
})()`;

// --- idle gating (Windows: GetLastInputInfo via PowerShell; else always idle) ---

function idleSecondsPs() {
  if (process.platform !== 'win32') return 0; // non-Windows: treat as always idle
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

// --- observability: rounds also land in x_worker.log (rmux panes swallow stdout) ---

const WORKER_LOG = process.env.X_WORKER_LOG ?? path.join(DATA, 'x_worker.log');
function wlog(msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`; // compact LOCAL HH:MM:SS
  console.log(line);
  try { appendFileSync(WORKER_LOG, line + '\n'); } catch { /* dir missing */ }
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

// --- window manipulation REMOVED (D11 hard rule) --------------------------------
// foreground()/restoreWindow() (dock 520x200 + activate + minimize) once
// fought background-tab throttling on the OLD agent-owned browser. Attached
// to the USER's browser, reshaping windows is out of bounds — opt-in or not.
// The runtime now has ZERO Browser.setWindowBounds / activate call sites.

// --- one capture round -------------------------------------------------------

/**
 * The home timeline is the ONLY harvestable surface: x.com root or /home.
 * A status page, search, profile… is the user browsing — probe/harvest must
 * not run there (D27): wait until a timeline tab exists again.
 */
const HOME_URL_RE = /^https?:\/\/(www\.)?x\.com(?:\/(?:home)?\/?)?(?:\?.*)?$/;
function homeTab(tabs) {
  return tabs.find(t => HOME_URL_RE.test(t.url.split('#')[0]));
}

async function store(sqlite, tweets) {
  const db = sqlite.openDb(DB_PATH);
  try {
    const inserted = sqlite.storeTweets(db, tweets.map(t => ({
      author: t.name ?? '', handle: t.handle ?? '', text: t.text ?? '',
      posted_at: t.time ?? '', url: t.link ? `https://x.com${t.link.startsWith('/') ? t.link : '/' + t.link}` : '',
    })));
    const st = sqlite.tweetStats(db); // { total, latest } — what the operator cares about
    return { inserted, ...st };
  } finally { db.close(); }
}

async function round(h) {
  // 1. find the home-timeline tab (D27: only the timeline is harvestable —
  //    any other x.com page means the user is browsing; WAIT, don't fail).
  //    No x.com tab at all still opens a background home tab (unchanged).
  const tabs = await h.list_tabs(false);
  const xtab = homeTab(tabs);
  let targetId;
  if (xtab) {
    await h.switch_tab(xtab.targetId, false);
    targetId = xtab.targetId;
  } else if (tabs.some(t => t.url.includes('x.com'))) {
    return null; // user on a status/search/profile page — wait, not error
  } else {
    targetId = await h.new_tab('https://x.com/home');
  }
  await h.wait_for_load(20);

  // 2. auto-trigger means auto-trigger: when the indicator shows a count we
  // harvest, even if the user happens to be looking at x.com right now (the
  // user's explicit spec — detection fires the round, no deferral).

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
  const st = await store(await importDist('sqlite.js'), unique);
  st.detected = unique.length; // page-extracted unique posts this round

  // 6. no restore step: we never touched any window (D11 hard rule —
  //    never close or reshape the user's browser, tabs included).
  return st;
}

// --- event-driven trigger ------------------------------------------------------
// Every 5s, probe the x.com tab for the "N new posts" indicator; the moment
// it shows a count, a harvest round auto-triggers. X_INTERVAL is only the
// fallback cap (default 5 min) for a tab whose indicator never renders;
// MIN_SPACING (60s) prevents harvest storms. js() works on hidden tabs —
// only painting throttles in the background, not evaluation.

const FALLBACK_INTERVAL = Number(process.env.X_INTERVAL ?? 300);
const MIN_ROUND_SPACING = Number(process.env.X_MIN_SPACING ?? 60);

/**
 * X's new-posts pill is anchored by data-testid="pillLabel" (observed
 * 2026-09-05): its text is「查看新帖子」(no count) or「显示 N 帖子」(with
 * count) depending on scroll state; the tab title carries a "(N)" badge.
 * The pill EXISTING means new posts wait — trigger on presence (count when
 * present), click the pill's own button. Numbers/booleans only — never
 * elements (Chrome 155 refuses returnByValue on DOM nodes).
 */
const PILL_COUNT = `(() => {
  const label = document.querySelector('[data-testid="pillLabel"]');
  if (label) {
    const m = (label.innerText || '').match(/\\d+/);
    return m ? Number(m[0]) : 1; // pill present = at least one new post
  }
  const tm = (document.title || '').match(/\\((\\d+)\\)/);
  return tm ? Number(tm[1]) : 0;
})()`;

/**
 * Hybrid trigger, checked every 5s:
 *  1. EVENT signals from the daemon's ring buffer — a HomeTimeline response
 *     (X just fetched new posts) or a tab-title badge change reacts the
 *     moment X itself learns about posts, even before any pill renders.
 *  2. PILL presence/count (the DOM truth — works when the tab is visible).
 *  3. Fallback cap for a quiet tab (FALLBACK_INTERVAL).
 * Ceiling on freshness is X's OWN update cadence: a hidden tab throttles
 * its timers, so even event signals arrive at ~1/min there.
 */
const TL_URL_RE = /Home(Latest)?Timeline|\/graphql\/[^/]+\/Home/;

async function waitForTrigger(h) {
  const deadline = Date.now() + FALLBACK_INTERVAL * 1000;
  while (Date.now() < deadline) {
    tick(); // the wait can outlive HEARTBEAT_TIMEOUT if we forget this
    try {
      // D27 human-coexistence gate: probe only on the home timeline. While
      // the user browses elsewhere on x.com there is nothing to probe —
      // wait (and never touch their tab, never open a new one).
      // NOTE: never drain_events here — draining erases the daemon's event
      // ring that the dashboard peeks. The pill probe is the trigger; the
      // fallback cap covers quiet tabs.
      const home = homeTab(await h.list_tabs(false));
      if (home) {
        await h.switch_tab(home.targetId, false);
        const n = Number(await h.js(PILL_COUNT) ?? 0);
        if (n > 0) return `pill x${n}`;
      }
    } catch { /* tab mid-navigation / daemon re-attaching — next tick */ }
    // D34 cadence: 6-8s jittered (coprime with page-detect's 10s sweep, and
    // the jitter prevents fixed-phase alignment — apps never probe in lockstep).
    await sleep(6 + Math.random() * 2);
  }
  return 'fallback-interval';
}

/** One cheap idle sample — true when the human has not touched input recently. */
function userIdleNow() {
  const idle = idleSecondsPs();
  return idle !== null && idle >= IDLE_THRESHOLD;
}

// --- main loop ---------------------------------------------------------------

/** The x-intel daemon's port: registry record is the authority. */
async function daemonPort() {
  if (process.env.BH_PORT) return Number(process.env.BH_PORT);
  const rec = JSON.parse(readFileSync(path.join(bhHome(), 'runtime', `bh-${process.env.BH_NAME ?? 'x-intel'}.port`), 'utf8'));
  return rec.port;
}

async function main() {
  const { ensureDaemon } = await importDist('admin.js');
  const { remoteHost } = await importDist('remote.js');
  const { createHelpers } = await importDist('helpers.js');
  await ensureDaemon();
  const h = createHelpers(remoteHost(await daemonPort()));

  // Pin the daemon's active session to the x.com tab up front: probes and
  // rounds must evaluate THERE, not on the daemon's dedicated blank tab.
  try {
    const tabs = await h.list_tabs(false);
    const xtab = tabs.find(t => t.url.includes('x.com'));
    if (xtab) await h.switch_tab(xtab.targetId, false);
  } catch { /* daemon still attaching — round 1 will switch */ }

  tick(); // visible to the supervisor immediately on start
  wlog(`x-intel::x-monitor 启动：5 秒探测 · 触发后 10 秒内随机启动抓取 · 兜底每 ${FALLBACK_INTERVAL} 秒`);
  let lastRoundAt = 0;
  for (;;) {
    const trigger = await waitForTrigger(h);
    // User spec: on detection, start the harvest after a RANDOM delay of up
    // to 10 seconds (natural jitter; no fixed rhythm to fingerprint).
    await sleepWithHeartbeat(Math.random() * 10);
    let ok = false;
    try {
      const r = await round(h); // { inserted, total, earliest, latest, detected } | null = waiting
      if (!r) {
        // D27: the user is browsing a non-timeline x.com page. This is
        // coexistence, not failure — no degraded state, no error event;
        // probing resumes the moment a home tab exists again.
        wlog('x-intel::x-monitor 等待\n时间线 tab 不在（用户浏览其他 x.com 页面），不动用户页面，恢复探测');
        writeStatus({
          state: 'running',
          metrics: [
            { label: '检测节奏', value: '等待时间线 tab（用户浏览中）' },
            { label: '库存', value: '监测中' },
          ],
        });
        ok = true; // waiting is a completed round, not a failure
        lastRoundAt = Date.now();
      } else {
      const zh = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '无';
      const triggerZh = { pill: '新帖指示器', 'timeline-response': '时间线更新', 'title-badge': '标题计数', 'fallback-interval': '定时兜底' }[trigger.split(' ')[0]] ?? trigger;
      const dup = r.detected - r.inserted;
      // Consistent arithmetic on ONE basis (what the page actually presented):
      // detected = inserted + already-in-db. The pill's own claim is context
      // noise (it reports "≥1" when it has no number), never a metric.
      wlog(`x-intel::x-monitor 刷新\n页面检测到新贴 ${r.detected} 个 · 新入库 ${r.inserted} 个 · 其中 ${dup} 个已存在 · 库存共 ${r.total} 帖`);
      writeStatus({
        state: 'running',
        metrics: [
          { label: '检测节奏', value: '5 秒探测 · 触发后 10 秒内随机抓取' },
          { label: '库存', value: `${r.total} 帖` },
          { label: '库内时间线', value: `${zh(r.earliest)} 至 ${zh(r.latest)}` },
        ],
        event: r.inserted > 0
          ? { ts: new Date().toISOString(), text: `新入库 ${r.inserted} · 共 ${r.total} 帖` }
          : undefined,
      });
      ok = true;
      lastRoundAt = Date.now();
      }
    } catch (e) {
      wlog(`x-intel::x-monitor 刷新失败：${e instanceof Error ? e.message : String(e)}\n${e instanceof Error ? String(e.stack ?? '').split('\n').slice(1, 4).join('\n') : ''}`);
      writeStatus({
        state: 'degraded',
        metrics: [],
        event: { ts: new Date().toISOString(), text: `刷新失败：${(e instanceof Error ? e.message : String(e)).slice(0, 60)}` },
      });
      // Self-heal the daemon as well: a dead daemon starves every round, but
      // the heartbeat keeps ticking so the supervisor cannot see this failure.
      try { await ensureDaemon(); } catch { /* next round retries */ }
    }
    if (!ok) await sleepWithHeartbeat(5); // failed round retries soon
  }
}

main().then(code => process.exit(code ?? 0), e => { console.error(e); process.exit(1); });
