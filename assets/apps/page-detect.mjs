/**
 * detect — page diagnosis on the ATTACHED browser (D11 attach primitive).
 *
 * Answers "why can't I use/login this page" with event-stream evidence:
 *   challenge-stuck : Cloudflare challenge loaded but its calls timed out
 *                     (blank page) -> advice: reload once
 *   blocked         : 403/429 cluster or wall words          -> honest report
 *   login-wall      : sign-in form rendered                   -> stop, ask user
 *   ok              : interactive page
 *
 * Usage: bh page-detect [url-substring]   (no arg = the daemon's active tab)
 * Attach-first: matches an EXISTING open tab; never opens one. No match ->
 * lists open tabs so the caller can pick (原语一：如实报，不自作主张创建).
 *
 * D18 watch mode — the universal page guardian:
 *   bh page-detect watch [--interval S]   start the detached watcher (idempotent)
 *   bh page-detect unwatch                stop it
 *   bh page-detect status                 current tabs verdicts + recent alerts
 * The watcher read-only probes EVERY http(s) page target of the attached
 * browser, classifies each (light verdict), and records edge alerts (tab
 * entering a wall class; blank only after persisting across cycles) to
 * <BH_HOME>/data/page-watch.json. The dashboard
 * (127.0.0.1:9870) merges that state into its snapshot; its already-granted
 * Notification layer turns the edges into system alerts. Chrome notifications
 * can only originate from a page origin the user granted — the watcher
 * detects, the dashboard displays.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

export const description = '常驻监测页面拦截与白屏等异常并告警。';
export const resident = true; // guardian app: lives in the dashboard 应用监控台

const VERSION = '1.1.0';

const bhHome = () => process.env.BH_HOME
  ?? process.env.BROWSER_HARNESS_HOME
  ?? (process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'browser-harness')
    : path.join(homedir(), '.config', 'browser-harness'));
const dataDirOf = () => process.env.BH_DATA_DIR ?? path.join(bhHome(), 'data');
const STATE_FILE = () => path.join(dataDirOf(), 'page-watch.json');
const STATUS_FILE = () => path.join(dataDirOf(), 'page-detect.status.json');
/** Guardian status contract (G002) — same schema x-intel publishes. */
function writeStatus(st) {
  try { mkdirSync(dataDirOf(), { recursive: true }); writeFileSync(STATUS_FILE(), JSON.stringify({ _v: '1.0.0', ts: new Date().toISOString(), ...st })); } catch { /* best-effort */ }
}
const PID_FILE = () => path.join(dataDirOf(), 'page-watch.pid');
const LOG_FILE = () => path.join(dataDirOf(), 'page-watch.log');

/** Own log stream so the guardian's events show in the dashboard log rail
 * (same `[HH:MM:SS] title\n detail` shape the x-intel worker uses). 1MB rotate. */
function logLine(text) {
  try {
    mkdirSync(dataDirOf(), { recursive: true });
    const f = LOG_FILE();
    try {
      if (statSync(f).size > 1_000_000) {
        const tail = readFileSync(f, 'utf8').slice(-500_000);
        writeFileSync(f, tail.slice(tail.indexOf('\n') + 1) + '\n');
      }
    } catch { /* fresh file */ }
    appendFileSync(f, text + '\n');
  } catch { /* best-effort */ }
}
const hms = () => new Date().toTimeString().slice(0, 8);

const WALL_CLASSES = new Set(['challenge-stuck', 'blocked', 'login-wall', 'asset-throttled']);
// blank is alerted too, but only after PERSISTING across cycles (a navigating
// page is blank for a moment by nature — one flash is not an incident).
const BLANK_CYCLES_BEFORE_ALERT = 2;

/**
 * Light per-tab classification from a read-only DOM probe (no events, no input).
 * The dominant real-world blockers get their own professional wording:
 * Google anti-automation (reCAPTCHA / /sorry), Cloudflare challenges, and
 * Cloudflare/CDN asset-domain refusal (skeleton page).
 */
function classify(p, url) {
  const title = String(p.title || '');
  const head = String(p.head || '');
  const u = String(url || '');
  if (/google\.[a-z.]+\/sorry/.test(u) || /unusual traffic from your computer|recaptcha/i.test(head.slice(0, 300))) {
    return { verdict: 'blocked', advice: 'Google 反自动化验证（/sorry 或 reCAPTCHA）：在浏览器窗口完成人机验证即可恢复；反复触发请降低请求频率或更换出口 IP' };
  }
  if (/请稍候|just a moment|attention required|verify you are human|checking your browser/i.test(title + ' ' + head.slice(0, 200))) {
    return { verdict: 'challenge-stuck', advice: 'Cloudflare 挑战拦截（五秒盾/人机校验）：在浏览器窗口完成验证即恢复；高频触发通常是出口 IP 信誉问题' };
  }
  if (/captcha|access denied|rate limit|人机验证|请求频率/i.test(head)) {
    return { verdict: 'blocked', advice: '站点拦截/限流（403/429 或验证词）：不硬闯；核对出口 IP 与请求节奏后重试' };
  }
  const assetFails = (p.assets || []).filter(a => /^(403|429|503)\b/.test(String(a)));
  if (assetFails.length >= 3) {
    return { verdict: 'asset-throttled', advice: '资源域被 Cloudflare/CDN 拒绝（骨架页/样式缺失）：主域存活但 chunks/fonts 403/429，多为出口 IP 限流；更换出口或等待窗口期恢复' };
  }
  if (/(sign in|log in|登录|登陆)/i.test(head.slice(0, 300)) && /(password|email|continue|继续)/i.test(head.slice(0, 300))) {
    return { verdict: 'login-wall', advice: '登录墙：需账号凭据，由用户在窗口完成登录（bh 不代输凭据）' };
  }
  if (!p.len) return { verdict: 'blank', advice: '页面空白（无正文无失败签名）：多为加载中或渲染异常，建议截图比对后重载' };
  return { verdict: 'ok', advice: '' };
}

/** Attach -> Runtime.enable -> evaluate one JSON probe. Caller detaches. */
// D31 self-heal bookkeeping: consecutive "eval busy" means the daemon's
// single-flight slot is latched; the watch loop restarts OUR named daemon
// after 2 in a row (the daemon's zombie-reaper is the primary fix; this is
// the belt that also covers older daemons).
let busyStreak = 0;

async function probeTab(h, targetId) {
  try {
    const r = await h.cdp('Target.attachToTarget', { targetId, flatten: true });
    await h.cdp('Runtime.enable', {}, { sessionId: r.sessionId }).catch(() => {});
    const out = await h.cdp('Runtime.evaluate', {
      expression: 'JSON.stringify({'
        + 'len: document.body ? document.body.innerText.length : 0, '
        + 'head: document.body ? document.body.innerText.slice(0, 400) : "", '
        + 'title: document.title, '
        + 'assets: (performance.getEntriesByType ? performance.getEntriesByType("resource").filter(function(r){'
        + '  return /cdn|static|assets|fonts|challenge-platform/.test(r.name) && (r.responseStatus === 403 || r.responseStatus === 429 || r.responseStatus === 503);'
        + '}).slice(0, 8).map(function(r){ return (r.responseStatus || 0) + " " + r.name.slice(0, 80); }) : [])'
        + '})',
      returnByValue: true,
    }, { sessionId: r.sessionId });
    const p = JSON.parse(out?.result?.value || '{}');
    busyStreak = 0;
    return { sid: r.sessionId, p: { len: p.len || 0, head: p.head || '', title: p.title || '', assets: p.assets || [] } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    busyStreak = /eval busy|429/.test(msg) ? busyStreak + 1 : 0;
    // Tab churn: the target closed between list_tabs and this attach. A gone
    // tab is withdrawn, not failed — no log, no event, the next sweep just
    // re-lists (same philosophy as D27: churn is a state, not an error).
    if (/No target with given id found/i.test(msg)) return null;
    logLine(`[${hms()}] page-detect 探测失败：${String(targetId).slice(0, 24)} ${msg}`);
    return null;
  }
}

function saveState(state) {
  try { mkdirSync(dataDirOf(), { recursive: true }); writeFileSync(STATE_FILE(), JSON.stringify(state)); } catch { /* best-effort */ }
}

/** The resident loop (runs inside its own detached CLI process). Never returns. */
async function watchLoop(h, intervalSec) {
  const state = /** @type {{ts: string, watching: boolean, interval: number, tabs: any[], alerts: any[]}} */ ({ ts: '', watching: true, interval: intervalSec, tabs: [], alerts: [] });
  const prev = new Map();
  const blankStreak = new Map();
  let lastSweepLog = 0;
  // Shared control-plane predicate (dist host.ts): exact host+port match, so
  // the watcher never probes the board yet never skips a lookalike local app.
  const { importDist } = await import('./lib.mjs');
  const { isDashboardUrl } = await importDist('host.js');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // Touch the heartbeat at the start of each sweep so a long tab list
      // cannot look stale to supervisor-core mid-cycle.
      saveState(state);
      const tabs = (await h.list_tabs(false)).filter(t => /^https?:/i.test(t.url) && !isDashboardUrl(t.url));
      const rows = [];
      let prevSid = /** @type {any} */ (null);
      for (const t of tabs) {
        if (prevSid) { await h.cdp('Target.detachFromTarget', { sessionId: prevSid }).catch(() => {}); prevSid = null; }
        // D34 cadence: a small inter-tab gap so a sweep of N tabs never
        // machine-guns the daemon with back-to-back evals.
        await new Promise(r => setTimeout(r, 150));
        const pr = await probeTab(h, t.targetId);
        if (!pr) continue;
        prevSid = pr.sid;
        const p = pr.p;
        const c = classify(p, t.url);
        rows.push({ targetId: t.targetId, url: t.url.slice(0, 120), title: (p.title || '').slice(0, 60), verdict: c.verdict, advice: c.advice });
        const before = prev.get(t.targetId);
        // Streak FIRST: cycle 1 of a blank episode already sets prev='blank',
        // so an edge check (before !== verdict) alone can never fire for a
        // persistent blank. Wall classes keep edge semantics (alert when a
        // tab ENTERS the class); blank alerts exactly once per episode, when
        // its streak crosses the persistence threshold.
        const blankNow = c.verdict === 'blank' ? (blankStreak.get(t.targetId) || 0) + 1 : 0;
        if (c.verdict === 'blank') blankStreak.set(t.targetId, blankNow);
        else blankStreak.delete(t.targetId);
        const alertNow = WALL_CLASSES.has(c.verdict)
          ? before !== c.verdict
          : blankNow === BLANK_CYCLES_BEFORE_ALERT;
        if (alertNow) {
          state.alerts.push({
            ts: new Date().toISOString(), targetId: t.targetId, url: t.url.slice(0, 120),
            title: (p.title || '').slice(0, 60), verdict: c.verdict, advice: c.advice, from: before ?? '(new)',
          });
          if (state.alerts.length > 50) state.alerts.splice(0, state.alerts.length - 50);
          logLine(`[${hms()}] page-detect 告警：${(p.title || t.url || '').slice(0, 60)}（${c.verdict}）\n${c.advice}\n${t.url.slice(0, 100)}`);
        }
        prev.set(t.targetId, c.verdict);
      }
      if (prevSid) { await h.cdp('Target.detachFromTarget', { sessionId: prevSid }).catch(() => {}); prevSid = null; }
      for (const k of [...prev.keys()]) if (!rows.some(r => r.targetId === k)) { prev.delete(k); blankStreak.delete(k); }
      state.tabs = rows;
      state.ts = new Date().toISOString();
      saveState(state);
      const bad = rows.filter(r => r.verdict !== 'ok').length;
      writeStatus({
        state: 'running',
        // interval is the persisted desired cadence: ensureCompanions and
        // supervisor-core respawns read it instead of hardcoding a default.
        interval: intervalSec,
        metrics: [
          { label: '巡检节奏', value: `${intervalSec} 秒/轮` },
          { label: '巡检覆盖', value: `${rows.length} 页` },
          { label: '异常', value: `${bad}` },
        ],
      });
      // quiet heartbeat line ~once a minute so the log rail shows the sweep
      if (Date.now() - lastSweepLog > 60_000) {
        lastSweepLog = Date.now();
        logLine(`[${hms()}] page-detect 巡检：${rows.length} 页 · 异常 ${bad}`);
      }
    } catch { /* browser detached/daemon gone: keep the loop, retry next tick */ }
    // D31 self-heal: a latched single-flight slot shows up as consecutive
    // "eval busy" probe failures. Restart OUR named daemon to clear it — the
    // probes re-attach on the next tick (same port, fresh registry record).
    if (busyStreak >= 2) {
      busyStreak = 0;
      logLine(`[${hms()}] page-detect 自愈：连续 eval busy，重启 page-detect daemon 清单飞锁`);
      try {
        const { spawnSync } = await import('node:child_process');
        spawnSync(process.execPath, [process.argv[1] ?? '', '--name', 'page-detect', '--restart', '--yes'],
          { stdio: 'ignore', windowsHide: true, timeout: 60_000 });
      } catch { /* next streak retries */ }
    }
    // D34 cadence: ±15% jitter on the sweep interval so the watcher and
    // x-intel's probe loop never align phases (coprime base + jitter).
    await new Promise(r => setTimeout(r, intervalSec * 1000 * (0.85 + Math.random() * 0.3)));
  }
}

/**
 * Watch lifecycle rides the rmux supervision plane (same as x-intel): the loop
 * lives in an rmux session, so it shows up in the dashboard 后台任务 card and
 * is inspectable like any supervised background task. Bare-detached spawn
 * remains as fallback when rmux is not installed.
 */
const WATCH_SESSION = 'page-detect';

async function watchStart(intervalSec) {
  writeStatus({ state: 'running', interval: intervalSec, metrics: [{ label: '巡检节奏', value: `${intervalSec} 秒/轮` }] });
  let via = 'detached';
  try {
    const { importDist } = await import('./lib.mjs');
    const { Rmux } = await importDist('rmux.js');
    const r = new Rmux();
    if (r.version()) {
      via = 'rmux';
      if (await r.hasSession(WATCH_SESSION)) {
        let running = null; // cadence the live loop reports in page-watch.json
        try { running = JSON.parse(readFileSync(STATE_FILE(), 'utf8')).interval ?? null; } catch { /* no state yet */ }
        if (running === null || running === intervalSec) {
          console.log(JSON.stringify({ _ok: true, _v: VERSION, _ts: new Date().toISOString(), watching: true, supervised: 'rmux:' + WATCH_SESSION, interval: running ?? intervalSec, note: 'already running' }, null, 1));
          return 0;
        }
        // Different interval requested: adopting the session would silently
        // ignore it. Kill and respawn below with the requested argv — the
        // status written above already carries the NEW interval, so a racing
        // supervisor beat respawns with it too.
        await r.killSession(WATCH_SESSION);
      }
      await r.newSession(WATCH_SESSION, {
        command: `"${process.execPath}" "${process.argv[1]}" --name page-detect page-detect watch --watch-loop --interval ${intervalSec}`,
      });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise(res => setTimeout(res, 300));
        if (await r.hasSession(WATCH_SESSION)) break;
      }
      console.log(JSON.stringify({ _ok: true, _v: VERSION, _ts: new Date().toISOString(), watching: true, supervised: 'rmux:' + WATCH_SESSION, interval: intervalSec }, null, 1));
      return 0;
    }
  } catch {
    // rmux path failed. A racing supervisor beat may have just (re)spawned
    // the session — that IS the watcher; never bare-spawn a second copy.
    try {
      const { importDist } = await import('./lib.mjs');
      const { Rmux } = await importDist('rmux.js');
      if (await new Rmux().hasSession(WATCH_SESSION)) {
        console.log(JSON.stringify({ _ok: true, _v: VERSION, _ts: new Date().toISOString(), watching: true, supervised: 'rmux:' + WATCH_SESSION, note: 'session appeared (supervisor race) — adopted' }, null, 1));
        return 0;
      }
    } catch { /* rmux genuinely absent: bare spawn below */ }
  }
  try {
    const pid = Number(readFileSync(PID_FILE(), 'utf8'));
    if (pid && process.kill(pid, 0)) {
      let running = /** @type {any} */ (null);
      try { running = JSON.parse(readFileSync(STATE_FILE(), 'utf8')).interval ?? null; } catch { /* no state yet */ }
      if (running === null || running === intervalSec) {
        console.log(JSON.stringify({ _ok: true, _v: VERSION, _ts: new Date().toISOString(), watching: true, pid, interval: running ?? intervalSec, note: 'already running' }, null, 1));
        return 0;
      }
      try { process.kill(pid); } catch { /* already gone */ } // respawn below at the requested cadence
    }
  } catch { /* not running */ }
  const child = /** @type {import('node:child_process').ChildProcess} */ (spawn(process.execPath, [process.argv[1] ?? '', '--name', 'page-detect', 'page-detect', 'watch', '--watch-loop', '--interval', String(intervalSec)], {
    detached: true, stdio: 'ignore',
  }));
  child.unref();
  try { mkdirSync(dataDirOf(), { recursive: true }); writeFileSync(PID_FILE(), String(child.pid)); } catch { /* best-effort */ }
  console.log(JSON.stringify({ _ok: true, _v: VERSION, _ts: new Date().toISOString(), watching: true, pid: child.pid, via, interval: intervalSec }, null, 1));
  return 0;
}

async function watchStop() {
  // Persist stopped first so a concurrent supervisor beat / ensureCompanions
  // will not respawn the session we are about to kill.
  writeStatus({ state: 'stopped', metrics: [], event: undefined });
  let killed = false;
  try {
    const { importDist } = await import('./lib.mjs');
    const { Rmux } = await importDist('rmux.js');
    const r = new Rmux();
    if (r.version() && await r.hasSession(WATCH_SESSION)) {
      await r.killSession(WATCH_SESSION);
      killed = true;
    }
  } catch { /* rmux path failed */ }
  if (!killed) {
    try { const pid = Number(readFileSync(PID_FILE(), 'utf8')); process.kill(pid); killed = true; } catch { /* not running */ }
  }
  try { unlinkSync(PID_FILE()); } catch { /* already gone */ }
  try {
    const st = JSON.parse(readFileSync(STATE_FILE(), 'utf8'));
    st.watching = false;
    saveState(st);
  } catch { /* no state yet */ }
  console.log(JSON.stringify({ _ok: true, _v: VERSION, _ts: new Date().toISOString(), watching: false, killed }, null, 1));
  return 0;
}

export async function main(argv = [], ctx) {
  const { helpers: h } = ctx;
  const pos = argv.filter(a => !a.startsWith('-'));
  const sub = pos[0];

  // D18 guardian subcommands
  if (sub === 'watch' && argv.includes('--watch-loop')) return watchLoop(h, Number(argv.find((a, i) => argv[i - 1] === '--interval') ?? 10) || 10);
  if (sub === 'watch') return watchStart(Number(argv.find((a, i) => argv[i - 1] === '--interval') ?? 10) || 10);
  if (sub === 'unwatch' || sub === 'watch-stop') return watchStop();
  if (sub === 'status') {
    try {
      const st = JSON.parse(readFileSync(STATE_FILE(), 'utf8'));
      console.log(JSON.stringify(st, null, 1));
      return 0;
    } catch {
      process.stderr.write('bh: no watch state yet — run `bh page-detect watch` first\n');
      return 2;
    }
  }

  // one-shot diagnosis (unchanged behaviour); `sub` is the url-substring when present
  const want = sub;

  // 1. resolve the target tab among what's already open (attach primitive)
  let tab = /** @type {any} */ (null);
  if (want) {
    const tabs = await h.list_tabs();
    tab = tabs.find(t => t.url.includes(want));
    if (!tab) {
      process.stderr.write(`bh: no open tab matches ${JSON.stringify(want)} — open tabs: ${tabs.map(t => t.url.slice(0, 50)).join(' | ')}\n`);
      return 2;
    }
    await h.switch_tab(tab.targetId, false); // background attach
  }
  const cur = await h.current_tab();

  // 2. fresh evidence: drain the ring buffer, reload-free first pass
  const evs = await h.drain_events();
  const reqUrl = new Map();
  const fails = [];
  const statuses = [];
  let challengeSeen = false;
  for (const e of evs) {
    if (e.method === 'Network.requestWillBeSent') {
      const u = e.params.request.url;
      reqUrl.set(e.params.requestId, u);
      if (/cdn-cgi\/challenge-platform/.test(u)) challengeSeen = true;
    } else if (e.method === 'Network.loadingFailed') {
      fails.push({ url: (reqUrl.get(e.params.requestId) || '?').slice(0, 90), error: e.params.errorText });
    } else if (e.method === 'Network.responseReceived') {
      const s = e.params.response.status;
      if (s >= 400) statuses.push(`${s} ${(reqUrl.get(e.params.requestId) || e.params.response.url).slice(0, 80)}`);
      if (/cdn-cgi\/challenge-platform/.test(e.params.response.url)) challengeSeen = true;
    }
  }

  // 3. page truth
  const info = await h.page_info();
  const ready = await h.js('document.readyState').catch(() => '?');
  const bodyText = typeof info.dialog === 'object' ? '' : String(await h.js('document.body.innerText').catch(() => '') || '');
  const bodyLen = bodyText.length;
  const signIn = /sign in|log in|登录|登陆/i.test(bodyText.slice(0, 800)) && /password|email|continue|继续/i.test(bodyText.slice(0, 800));
  const wallWords = /captcha|verify you are human|access denied|rate limit|请求频率|人机验证/i.test(bodyText.slice(0, 1500));

  // 4. verdict (ordered: hard failure first)
  let verdict, advice;
  if (bodyLen === 0 && challengeSeen) {
    verdict = 'challenge-stuck';
    advice = '重载一次重跑人机验证；反复卡死 = 到挑战端点的网络路径问题';
  } else if (bodyLen === 0 && fails.some(f => /TIMED_OUT/.test(f.error))) {
    verdict = 'network-stalled';
    advice = '核心请求超时且页面空白：检查该站网络路径/代理';
  } else if (wallWords || statuses.filter(s => s.startsWith('403') || s.startsWith('429')).length >= 3) {
    verdict = 'blocked';
    advice = /google\.[a-z.]+\/sorry/.test(cur.url) || /unusual traffic/i.test(bodyText.slice(0, 400))
      ? 'Google 反自动化验证（/sorry 或 reCAPTCHA）：窗口完成人机验证即恢复；反复触发请降频或更换出口 IP'
      : '检测到墙/验证码/限流（403/429 簇）：如实报告不硬闯，核对出口 IP 与请求节奏';
  } else if (signIn) {
    verdict = 'login-wall';
    advice = '登录表单已渲染：停下让用户登录，凭据越界';
  } else if (bodyLen === 0) {
    verdict = 'blank';
    advice = '页面无文本且无失败签名：截图比对后重载';
  } else {
    // asset-domain starvation: the shell loads but the content engine's
    // CDN (chunks/fonts) is throttled/refused — page renders as a skeleton.
    const assetFails = [
      ...fails.map(f => ({ url: f.url, err: f.err ?? f.error })),
      ...statuses.map(s => ({ url: s.slice(4), err: s.slice(0, 3) })),
    ].filter(f => /cdn|glyph|static|assets/.test(f.url) && /(ERR_FAILED|429|403)/.test(String(f.err)));
    if (assetFails.length >= 3) {
      verdict = 'asset-throttled';
      advice = '资源域被拒而主域存活：出口 IP 限流，换出口或等窗口';
    } else {
      verdict = 'ok';
      advice = '页面可交互';
    }
  }

  const report = {
    _ok: true, _v: VERSION, _ts: new Date().toISOString(),
    url: cur.url, title: (cur.title || '').slice(0, 60),
    verdict, advice,
    page: { ready, bodyLen, dialog: info.dialog ?? null },
    evidence: {
      challengePlatform: challengeSeen,
      failedRequests: fails.slice(-6),
      httpErrors: statuses.slice(-6),
    },
  };
  console.log(JSON.stringify(report, null, 1));
  return verdict === 'ok' ? 0 : 1;
}
