/**
 * x-worker — the business loop. Runs in rmux session "x-intel";
 * supervisor-core heals the session. Drives a DEDICATED daemon
 * (BH_NAME=x-intel) attached to the USER's browser (D11: never spawn,
 * never reshape/close windows, never touch a tab the user is reading).
 *
 * Lane rule (D40) — monitor and search are independent surfaces:
 *   monitor (this file): ATTACH-ONLY. Every 6-8s it polls for a user-opened
 *   x.com root/home timeline tab; while none exists it keeps waiting and
 *   never opens one. Every eval is PINNED to that tab's targetId
 *   (`js(expr, targetId)`), so the daemon's active tab is never stolen from
 *   another lane.
 *   search (harvest.mjs): owns its own tab — opened by the app, closed by it.
 *
 * Trigger: the moment the timeline shows the "N new posts" indicator a
 * harvest round fires (X_INTERVAL is only the fallback cap).
 * Round: scroll-harvest articles (≤6 beats) → click the pill → store to
 * x_tweets.db.
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

/**
 * readyState poll PINNED to one targetId (never the daemon's active tab).
 * `timeout` is seconds. A lost evaluate is "unknown", not failure — this
 * wait's own deadline is the verdict (same contract as wait_for_load).
 */
async function waitReadyPinned(h, targetId, timeout) {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    try { if ((await h.js('document.readyState', targetId)) === 'complete') return true; } catch { /* mid-navigation */ }
    await sleep(0.5);
  }
  return false;
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
  //    D40 attach-only: with NO home tab there is nothing to attach to, so
  //    the monitor waits — it never opens a tab of its own (the user's
  //    browser surface stays exactly as they left it).
  const tabs = await h.list_tabs(false);
  const xtab = homeTab(tabs);
  if (!xtab) return null; // user on another x.com page, or no x.com tab at all — wait
  // D40: every eval below is pinned to THIS tab. The daemon's active tab is
  // left alone, so a concurrent x-harvest on its own tab (and the human
  // clicking around) cannot have their context yanked by the monitor.
  const targetId = xtab.targetId;
  await waitReadyPinned(h, targetId, 20);

  // 2. auto-trigger means auto-trigger: when the indicator shows a count we
  // harvest, even if the user happens to be looking at x.com right now (the
  // user's explicit spec — detection fires the round, no deferral).

  // 3. scroll-harvest, ≤6 beats; stop when the page height stops growing
  let all = [];
  let prevH = 0;
  for (let beat = 0; beat < 6; beat++) {
    const batch = (await h.js(EXTRACT, targetId)) ?? [];
    all = all.concat(batch);
    await h.js('window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))', targetId);
    await sleep(1);
    const height = await h.js('document.documentElement.scrollHeight', targetId);
    if (height === prevH) break;
    prevH = height;
  }

  // 4. back to top; click the "new posts" pill (≤2 tries) and harvest again
  await h.js('window.scrollTo(0, 0)', targetId);
  await sleep(1);
  for (let i = 0; i < 2; i++) {
    const found = await h.js(FIND_PILL, targetId);
    if (found) {
      await h.js(CLICK_PILL, targetId);
      await sleep(2.5);
      all = all.concat((await h.js(EXTRACT, targetId)) ?? []);
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

// --- attach-only trigger -------------------------------------------------------
// Every 6-8s, poll for the user's x.com home tab and probe its "N new posts"
// indicator; the moment it shows a count, a harvest round auto-triggers.
// X_INTERVAL is only the fallback cap (default 5 min) for a tab whose
// indicator never renders; MIN_SPACING (60s) prevents harvest storms. js()
// works on hidden tabs — only painting throttles in the background, not
// evaluation.

const FALLBACK_INTERVAL = Number(process.env.X_INTERVAL ?? 300);
const MIN_ROUND_SPACING = Number(process.env.X_MIN_SPACING ?? 60);
// D40: with no home tab open there is nothing to attach to. Report that state
// once the absence has survived a couple of ticks (a real "waiting", not a
// navigation hiccup), then keep polling inside the same fallback window.
const NO_HOME_REPORT_MS = Number(process.env.X_NO_HOME_REPORT_MS ?? 15) * 1000;

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
 * Attach-only trigger loop, one tick every 6-8s:
 *  - no home tab → keep waiting ('no-home-tab' once the gap is not a hiccup)
 *  - home tab, PILL_COUNT > 0 → 'pill xN' (harvest fires)
 *  - home tab, quiet → keep probing until the FALLBACK_INTERVAL cap
 * The probe is PINNED to the home tab's targetId (D40): the daemon's active
 * tab is never switched, so a running search lane keeps its own context.
 * Ceiling on freshness is X's OWN update cadence: a hidden tab throttles its
 * timers. NOTE: never drain_events here — draining erases the daemon's event
 * ring that the dashboard peeks.
 */
async function waitForTrigger(h) {
  const deadline = Date.now() + FALLBACK_INTERVAL * 1000;
  let absentSince = 0;
  while (Date.now() < deadline) {
    tick(); // the wait can outlive HEARTBEAT_TIMEOUT if we forget this
    try {
      // D27 human-coexistence gate: probe only on the home timeline. While
      // the user browses elsewhere on x.com there is nothing to probe — wait
      // (and never touch their tab, never open a new one; D40: this lane
      // never creates a tab, period).
      const home = homeTab(await h.list_tabs(false));
      if (home) {
        absentSince = 0;
        const n = Number(await h.js(PILL_COUNT, home.targetId) ?? 0);
        if (n > 0) return `pill x${n}`;
      } else if (!absentSince) {
        absentSince = Date.now();
      } else if (Date.now() - absentSince >= NO_HOME_REPORT_MS) {
        return 'no-home-tab';
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

/**
 * Wording for the waiting state: "no x.com tab at all" (attach-side) and
 * "user is browsing another x.com page" (D27) are both waiting, not failure.
 */
async function waitingText(h) {
  try {
    const tabs = await h.list_tabs(false);
    if (tabs.some(t => t.url.includes('x.com'))) return '等待时间线 tab（用户浏览其他 x.com 页面）';
  } catch { /* daemon re-attaching — report the attach-side wording */ }
  return '等待打开 x.com 主页 tab（只附着，不自建）';
}

/** The x-intel daemon's port: registry record is the authority (the default
 *  instance's record is bh.port, not bh-default.port — readInstanceRecord
 *  knows the mapping). */
async function daemonPort() {
  if (process.env.BH_PORT) return Number(process.env.BH_PORT);
  const { instanceName, readInstanceRecord } = await importDist('paths.js');
  const rec = readInstanceRecord(instanceName());
  if (!rec) throw new Error(`no registry record for instance "${instanceName()}" — run the app start first`);
  return rec.port;
}

async function main() {
  const { ensureDaemon } = await importDist('admin.js');
  const { remoteHost } = await importDist('remote.js');
  const { createHelpers } = await importDist('helpers.js');
  await ensureDaemon();
  const h = createHelpers(remoteHost(await daemonPort()));

  tick(); // visible to the supervisor immediately on start
  wlog(`x-intel:: 启动：只附着已打开的 x.com 主页（没有就等，不自建 tab）· 6-8 秒随机探测 · 触发后 10 秒内随机抓取 · 轮间隔 ≥${MIN_ROUND_SPACING} 秒 · 兜底每 ${FALLBACK_INTERVAL} 秒`);
  // Waiting is a state, not an event: report it on transition (and refresh the
  // dashboard card), never as a log line every tick.
  let waitLogged = '';
  const noteWaiting = (text) => {
    writeStatus({
      state: 'running',
      metrics: [
        { label: '检测节奏', value: text },
        { label: '库存', value: '监测中（等待附着）' },
      ],
    });
    if (waitLogged !== text) {
      wlog(`x-intel:: 等待\n${text}，不动用户页面，继续探测`);
      waitLogged = text;
    }
  };
  let lastRoundAt = 0;
  for (;;) {
    const trigger = await waitForTrigger(h);
    // D40 attach-only: no user-opened x.com home tab → nothing to attach to.
    // Wait (the user's browser is never reshaped) and keep polling.
    if (trigger === 'no-home-tab') {
      noteWaiting(await waitingText(h));
      continue;
    }
    waitLogged = '';
    // Harvest-storm guard: MIN_ROUND_SPACING exists precisely for this gate.
    // Without it a background tab's title badge (N) — which never clears on
    // its own — keeps the trigger lit and rounds fire back-to-back (~10s
    // apart, all duplicates). Space actual rounds; the wait heartbeats so
    // the supervisor still sees a live worker.
    const since = Date.now() - lastRoundAt;
    if (since < MIN_ROUND_SPACING * 1000) {
      await sleepWithHeartbeat(MIN_ROUND_SPACING - since / 1000);
    }
    // User spec: on detection, start the harvest after a RANDOM delay of up
    // to 10 seconds (natural jitter; no fixed rhythm to fingerprint).
    await sleepWithHeartbeat(Math.random() * 10);
    let ok = false;
    try {
      const r = await round(h); // { inserted, total, earliest, latest, detected } | null = waiting
      if (!r) {
        // D27/D40: the tab went away (user navigated off the timeline).
        // Coexistence, not failure — no degraded state, no error event.
        noteWaiting(await waitingText(h));
        ok = true; // waiting is a completed round, not a failure
        lastRoundAt = Date.now();
      } else {
        const zh = (iso) => iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '无';
        const triggerZh = { pill: '新帖指示器', 'fallback-interval': '定时兜底' }[trigger.split(' ')[0]] ?? trigger;
        const dup = r.detected - r.inserted;
        // Consistent arithmetic on ONE basis (what the page actually presented):
        // detected = inserted + already-in-db. The pill's own claim is context
        // noise (it reports "≥1" when it has no number), never a metric.
        wlog(`x-intel:: 刷新（${triggerZh}）\n页面检测到新贴 ${r.detected} 个 · 新入库 ${r.inserted} 个 · 其中 ${dup} 个已存在 · 库存共 ${r.total} 帖`);
        writeStatus({
          state: 'running',
          metrics: [
            { label: '检测节奏', value: `6-8 秒随机探测 · 轮间隔 ≥${MIN_ROUND_SPACING} 秒` },
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
      wlog(`x-intel:: 刷新失败：${e instanceof Error ? e.message : String(e)}\n${e instanceof Error ? String(e.stack ?? '').split('\n').slice(1, 4).join('\n') : ''}`);
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
