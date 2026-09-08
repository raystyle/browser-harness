/**
 * dashboard — a read-only 127.0.0.1 web board for the attach era.
 *
 * Shows, in one macOS-style page (SSE-pushed every 1s):
 *   1. daemon instances    — health, uptime, connection, active tab
 *   2. attach surface      — every operable tab of each attached browser
 *                            (🐴 marks tabs bh operates)
 *   3. rmux supervision    — sessions + pane tree
 *   4. worker heartbeat    — age + x_worker.log tail
 *   5. page verdicts       — light six-verdict health per active tab
 *
 * Strictly read-only: this process never starts/stops/kills anything and
 * never touches the browser beyond read-only CDP calls.
 */

import { createServer, type ServerResponse } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstanceRecord, runtimeDir, tmpDir, workspaceDir, dataDir, DEFAULT_NAME } from './paths.js';
import { health, evalOn } from './admin.js';
import { Rmux } from './rmux.js';
import { skillStatus } from './skills.js';
import { workspaceDir as wsDir } from './paths.js';

export const DASHBOARD_PORT = Number(process.env.BH_DASHBOARD_PORT ?? 9870);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// collectors (all read-only; rmux/detect cached to keep the 1s loop cheap)
// ---------------------------------------------------------------------------

function instanceNames(): string[] {
  const out = new Set<string>([DEFAULT_NAME]);
  try {
    for (const f of readdirSync(runtimeDir())) {
      const m = /^bh-(.+)\.port$/.exec(f);
      if (m?.[1] && m[1] !== 'x-core') out.add(m[1]);
    }
  } catch { /* runtime dir empty */ }
  return [...out].filter(Boolean);
}

type TabRow = { targetId: string; url: string; title: string; active: boolean; marked: boolean };
type InstanceRow = {
  name: string; alive: boolean; port: number; pid?: number | undefined; uptime?: number | undefined;
  connected?: boolean | undefined; replacements?: number; activeTab: TabRow | null;
  tabs: TabRow[]; verdict?: { verdict: string; advice: string } | undefined; error?: string | undefined;
};

const MARKER_HEAD = '\u{1F434}';

async function collectInstance(name: string): Promise<InstanceRow> {
  const rec = readInstanceRecord(name);
  const port = rec?.port ?? 0;
  const row: InstanceRow = { name, alive: false, port, activeTab: null, tabs: [] };
  if (!rec) return row;
  const h = await health(port, 800);
  row.alive = !!h?.ok && h?.name === name;
  row.pid = rec.pid;
  row.uptime = h?.uptime;
  row.connected = h?.connected;
  if (!row.alive || !h?.connected) return row;

  // Operable tabs (browser-level list_tabs) work even when the instance is
  // connected but NOT attached; current_tab() throws "not attached" for the
  // lazy default instance — that is normal, not an error.
  let tabs: Array<{ targetId: string; url: string; title: string }> = [];
  try {
    tabs = await evalOn<Array<{ targetId: string; url: string; title: string }>>(port,
      'return await list_tabs()', 4000) ?? [];
  } catch { /* tabs unavailable */ }
  let cur: { targetId: string } | null = null;
  try {
    cur = await evalOn<{ targetId: string } | null>(port, 'return await current_tab()', 4000);
  } catch { /* not attached — normal for the lazy default instance */ }
  row.tabs = tabs.map(t => ({
    targetId: t.targetId, url: t.url, title: t.title,
    active: t.targetId === cur?.targetId,
    marked: (t.title ?? '').startsWith(MARKER_HEAD),
  }));
  row.activeTab = row.tabs.find(t => t.active) ?? null;
  row.error = undefined;
  return row;
}

/** Light six/seven-verdict health of an instance's active tab (cached 30s). */
const verdictCache = new Map<string, { at: number; verdict: string; advice: string }>();
async function collectVerdict(inst: InstanceRow): Promise<{ verdict: string; advice: string } | undefined> {
  if (!inst.activeTab) return undefined;
  const hit = verdictCache.get(inst.name);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  try {
    const probe = await evalOn<{ len: number; head: string }>(inst.port,
      'return JSON.parse(await js(\'JSON.stringify({len: document.body.innerText.length, head: document.body.innerText.slice(0,300)})\'))', 5000);
    const evs = await evalOn<Array<{ method: string; params?: any }>>(inst.port,
      'return await __bh_meta("peek", {limit: 50})', 4000).catch(() => [] as Array<{ method: string; params?: any }>);
    const head = String(probe?.head ?? '');
    let challenge = false, fails = 0;
    for (const e of evs ?? []) {
      if (e.method === 'Network.responseReceived' && /cdn-cgi\/challenge-platform/.test(String(e.params?.response?.url ?? ''))) challenge = true;
      if (e.method === 'Network.loadingFailed') fails++;
    }
    let verdict = 'ok', advice = ''; // 正常不挂赘注
    if (probe?.len === 0 && challenge) { verdict = 'challenge-stuck'; advice = '重载一次，重跑人机验证'; }
    else if (/captcha|verify you are human|access denied|rate limit/i.test(head)) { verdict = 'blocked'; advice = '检测到拦截，如实报告不硬闯'; }
    else if (/sign in|log in/i.test(head) && /password|email|continue/i.test(head)) { verdict = 'login-wall'; advice = '登录墙，由用户登录'; }
    else if (probe?.len === 0) { verdict = 'blank'; advice = '页面空白，截图比对'; }
    const out = { verdict, advice, at: Date.now() } as { verdict: string; advice: string; at: number };
    verdictCache.set(inst.name, out);
    return out;
  } catch { return undefined; }
}

/** rmux status cached 10s (spawning rmux every 2s would be rude). */
let rmuxCache: { at: number; data: unknown } = { at: 0, data: null };
async function collectRmux(): Promise<unknown> {
  if (Date.now() - rmuxCache.at < 10_000) return rmuxCache.data;
  try {
    const r = new Rmux();
    const status = await r.status() as { sessions?: Array<{ name: string; panes?: Array<{ pid?: number }> }> };
    // Enrich panes with the REAL command line: rmux's pane_current_command is
    // just the exe name on Windows (node.exe) — the pid -> CommandLine map
    // tells you it's x-intel worker / supervisor-core / dashboard.js.
    const cmdByPid = await processCommandLines();
    for (const s of status.sessions ?? []) {
      for (const p of s.panes ?? []) {
        (p as any).commandLine = cmdByPid.get(p.pid ?? -1) ?? '';
      }
    }
    rmuxCache = { at: Date.now(), data: status };
  } catch { /* rmux absent */ }
  return rmuxCache.data;
}

/**
 * pid -> real node command line (cached 10s, one spawn). rmux panes report
 * the WRAPPER's pid (cmd.exe on Windows; node is its child), so the map keys
 * BOTH the node pid and its parent — a pane pid resolves through either.
 */
let procCache: { at: number; data: Map<number, string> } = { at: 0, data: new Map() };
async function processCommandLines(): Promise<Map<number, string>> {
  if (Date.now() - procCache.at < 10_000) return procCache.data;
  const map = new Map<number, string>();
  try {
    const { spawnSync } = await import('node:child_process');
    const script = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\' OR Name=\'cmd.exe\'" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { timeout: 15_000, windowsHide: true, encoding: 'utf8' });
    const parsed = JSON.parse(String(r.stdout ?? '').trim() || '[]') as Array<{ ProcessId: number; ParentProcessId: number; Name: string; CommandLine?: string }> | { ProcessId: number; ParentProcessId: number; Name: string; CommandLine?: string };
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (!row?.ProcessId) continue;
      if (/node\.exe/i.test(row.Name ?? '')) {
        const cl = row.CommandLine ?? '';
        map.set(row.ProcessId, cl);            // direct hit
        map.set(row.ParentProcessId, cl);      // the cmd wrapper pane
      }
    }
  } catch { /* best effort */ }
  procCache = { at: Date.now(), data: map };
  return map;
}

function collectWorker(): { heartbeatAgeS: number | null; logTail: string[]; pageLogTail: string[]; db: { total: number; earliest: string; latest: string } } {
  const out = { heartbeatAgeS: null as number | null, logTail: [] as string[], pageLogTail: [] as string[], db: { total: 0, earliest: '', latest: '' } };
  const hb = path.join(dataDir(), 'x_worker.heartbeat');
  try {
    const st = statSync(hb);
    out.heartbeatAgeS = Math.round((Date.now() - st.mtimeMs) / 100) / 10;
  } catch { /* no heartbeat */ }
  try {
    const log = path.join(dataDir(), 'x_worker.log');
    if (existsSync(log)) out.logTail = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-8)
      .map(l => l.replace(/x-core::/g, 'x-intel::'));
  } catch { /* unreadable */ }
  try {
    const log = path.join(dataDir(), 'page-watch.log');
    if (existsSync(log)) out.pageLogTail = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-8);
  } catch { /* unreadable */ }
  // Library inventory straight from sqlite (READ-ONLY; never via the daemon).
  try {
    const db = new DatabaseSync(path.join(dataDir(), 'x_tweets.db'), { readOnly: true } as never);
    const r = db.prepare(`SELECT COUNT(*) c, MIN(NULLIF(posted_at,'')) a, MAX(NULLIF(posted_at,'')) m FROM tweets`).get() as { c?: number; a?: string | null; m?: string | null } | undefined;
    db.close();
    out.db = { total: Number(r?.c ?? 0), earliest: String(r?.a ?? ''), latest: String(r?.m ?? '') };
  } catch { /* db absent */ }
  return out;
}

/** Install & asset inventory for the left source bar (cached 60s — hashing files). */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let assetCache: { at: number; data: ReturnType<typeof buildAssets> } | null = null;
function buildAssets() {
  const dirs = (p: string) => { try { return readdirSync(p).filter(f => statSync(path.join(p, f)).isDirectory()).length; } catch { return 0; } };
  const list = (p: string, ext: string) => { try { return readdirSync(p).filter(f => f.endsWith(ext)).map(f => f.slice(0, -ext.length)).sort(); } catch { return [] as string[]; } };
  let version = 'unknown', mode = 'dev';
  try { version = String(JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version); } catch { /* keep */ }
  try { mode = statSync(path.join(PKG_ROOT, 'tsconfig.json')).isFile() ? 'dev' : 'npm'; } catch { mode = 'npm'; }
  return {
    version, mode,
    installDir: PKG_ROOT,
    workspaceDir: wsDir(),
    dataDir: dataDir(),
    sites: dirs(path.join(PKG_ROOT, 'assets', 'domain-skills')),
    appNames: list(path.join(PKG_ROOT, 'assets', 'apps'), '.mjs'),
    interaction: list(path.join(PKG_ROOT, 'skill', 'interaction-skills'), '.md'),
    primitives: list(path.join(PKG_ROOT, 'skill', 'primitives'), '.md').filter(f => f !== 'README'),
    skillLines: skillStatus().map(l => ({ ...l, dir: l.dir ?? '' })),
  };
}
function collectAssets() {
  if (!assetCache || Date.now() - assetCache.at > 60_000) assetCache = { at: Date.now(), data: buildAssets() };
  return assetCache.data;
}

/**
 * D17 app cards: one run ledger (app-runs.jsonl, written platform-side by
 * runPlugin) + per-app cache inventory + the `description` each app exports
 * (regex-extracted from source — importing 7 app modules per snapshot is not
 * worth the side-effect surface). Cached 10s to keep the 2s SSE loop cheap.
 */
type AppRun = { ts: string; app: string; argv: string; code: number; ms: number; log?: string[] };
function buildApps() {
  const ws = workspaceDir();
  const appNames: string[] = [];
  const desc: Record<string, string> = {};
  const resident: Record<string, boolean> = {};
  try {
    for (const f of readdirSync(path.join(ws, 'apps'))) {
      if (!f.endsWith('.mjs') || f === 'x-core.mjs') continue;
      const n = f.slice(0, -4);
      appNames.push(n);
      try {
        const src = readFileSync(path.join(ws, 'apps', f), 'utf8');
        desc[n] = /export\s+const\s+description\s*=\s*['"]([^'"]+)['"]/.exec(src)?.[1] ?? '';
        resident[n] = /export\s+const\s+resident\s*=\s*true/.test(src);
      } catch { desc[n] = ''; resident[n] = false; }
    }
  } catch { /* no apps dir */ }
  appNames.sort();
  const runs: AppRun[] = [];
  try {
    for (const line of readFileSync(path.join(dataDir(), 'app-runs.jsonl'), 'utf8').split(/\r?\n/).slice(-300)) {
      try { const r = JSON.parse(line); if (r && r.app) runs.push(r); } catch { /* skip */ }
    }
  } catch { /* ledger starts empty */ }
  const status = readAppStatus(appNames);
  const caches: Record<string, Array<{ cache: string; batches: number; last: string; count: number }>> = {};
  for (const n of appNames) {
    caches[n] = [];
    try {
      for (const f of readdirSync(path.join(ws, 'cache', n))) {
        if (!f.endsWith('.json')) continue;
        try {
          const batches = JSON.parse(readFileSync(path.join(ws, 'cache', n, f), 'utf8'));
          const last = batches[batches.length - 1];
          if (last) caches[n].push({ cache: f.replace(/\.json$/, ''), batches: batches.length, last: last._ts, count: last.count });
        } catch { /* skip cache file */ }
      }
    } catch { /* no cache dir yet */ }
  }
  return { appNames, desc, resident, status, runs, caches };
}
type AppStatus = { ts?: string; state?: string; metrics?: Array<{ label: string; value: string }>; event?: { ts: string; text: string; kind?: string } } | null;
function readAppStatus(appNames: string[]): Record<string, AppStatus> {
  const status: Record<string, AppStatus> = {};
  const dir = dataDir();
  for (const n of appNames) {
    try { status[n] = JSON.parse(readFileSync(path.join(dir, `${n}.status.json`), 'utf8')); } catch { status[n] = null; }
  }
  return status;
}
let appsCache: { at: number; data: ReturnType<typeof buildApps> } = { at: 0, data: buildApps() };
function collectApps() {
  const now = Date.now();
  if (now - appsCache.at > 10_000) appsCache = { at: now, data: buildApps() };
  else appsCache.data.status = readAppStatus(appsCache.data.appNames);
  return appsCache.data;
}

/** D18: the page-detect guardian's state file — all-tabs verdicts + edge alerts. */
function collectPageWatch(): { ts?: string; watching?: boolean; interval?: number; tabs?: Array<{ targetId: string; url: string; title: string; verdict: string; advice?: string }>; alerts?: Array<Record<string, unknown>> } {
  try {
    return JSON.parse(readFileSync(path.join(dataDir(), 'page-watch.json'), 'utf8'));
  } catch { return {}; }
}

export type DashboardState = {
  ts: string; port: number;
  instances: InstanceRow[];
  rmux: unknown;
  worker: ReturnType<typeof collectWorker>;
  apps: ReturnType<typeof buildApps>;
  pageWatch: ReturnType<typeof collectPageWatch>;
  pageV: string;
  assets: ReturnType<typeof buildAssets>;
};

/** djb2 over the page source — the version clients handshake against. */
function pageVersion(): string {
  let fp = 0;
  for (let i = 0; i < PAGE.length; i++) fp = (fp * 33 + PAGE.charCodeAt(i)) >>> 0;
  return String(fp);
}

async function snapshot(): Promise<DashboardState> {
  const names = instanceNames();
  const instances: InstanceRow[] = [];
  for (const n of names) {
    const row = await collectInstance(n);
    row.verdict = await collectVerdict(row) as { verdict: string; advice: string } | undefined;
    instances.push(row);
  }
  return { ts: new Date().toISOString(), port: DASHBOARD_PORT, instances, rmux: await collectRmux(), worker: collectWorker(), apps: collectApps(), pageWatch: collectPageWatch(), pageV: pageVersion(), assets: collectAssets() };
}

// ---------------------------------------------------------------------------
// server: / (page) + /events (SSE)
// ---------------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>BROWSER HARNESS看板</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  /* Apple design tokens — exact HIG values (macOS 14 / iOS 17 light) */
  :root {
    color-scheme: light;
    --bg: #f5f5f7; --win: #ffffff; --label: rgba(0,0,0,.85); --label2: rgba(60,60,67,.6); --label3: rgba(60,60,67,.3);
    --sep: rgba(60,60,67,.29); --sep-strong: #d2d2d7; --fill: rgba(120,120,128,.12);
    --blue: #007aff; --blue-deep: #0a66d0; --green: #34c759; --green-deep: #248a3d;
    --red: #ff3b30; --red-deep: #d70015; --orange: #ff9500; --orange-deep: #c46a00;
    --gray: #8e8e93;
  }
  * { box-sizing: border-box; margin: 0; }
  html, body { height: 100%; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI",
                    "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
         background: #e5e5e5; color: var(--label); font-size: 13px;
         -webkit-font-smoothing: antialiased; }
  .win { width: 100%; height: 100%; background: var(--win); overflow: hidden;
         display: flex; flex-direction: column; }
  /* unified titlebar: 52px Big Sur+, traffic lights 12px @ 8px gap, 20px inset */
  .titlebar { flex: 0 0 52px; position: relative; display: flex; align-items: center; justify-content: flex-end;
              padding: 0 16px;
              background: linear-gradient(#ededed, #e6e6e6); border-bottom: 1px solid #c6c6c8; }
  .titlebar b { position: absolute; left: 50%; transform: translateX(-50%);
                font-size: 13px; font-weight: 600; color: #1d1d1f;
                text-transform: uppercase; letter-spacing: .08em; }
  .nicon svg { width: 16px; height: 16px; display: block; }
  .layout { flex: 1; min-height: 0; display: flex; background: #f5f5f7; }
  .main { flex: 1; min-width: 0; padding: 16px; overflow-y: auto; background: #f5f5f7; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .rightside { flex: 0 0 34%; min-width: 360px; max-width: 520px; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px;
               min-height: 0; overflow-y: auto;
               background: #ececec; border-left: 1px solid #d2d2d7; }
  .railwrap { display: flex; flex-direction: column; min-height: 0; flex: 1; }
  .sourcebar { flex: 0 0 220px; width: 220px; padding: 8px 10px 12px; overflow-y: auto; min-height: 0;
               background: #e8e8ed; font-size: 13px; }
  .layout.nosource .sourcebar { display: none; }
  /* NSSplitView: 1px rule + circular chevron on the seam */
  .split { flex: 0 0 1px; position: relative; background: #d2d2d7; cursor: pointer; user-select: none; }
  .layout.nosource .split { flex: 0 0 16px; background: #e8e8ed; border-right: 1px solid #d2d2d7; }
  .splitarr { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
              width: 18px; height: 18px; border-radius: 50%;
              background: #fff; border: .5px solid rgba(0,0,0,.14);
              box-shadow: 0 1px 2px rgba(0,0,0,.08);
              color: #6e6e73; font-size: 9px; line-height: 18px; text-align: center;
              pointer-events: none; }
  .split:hover .splitarr { border-color: rgba(0,0,0,.22); color: #1d1d1f; }
  /* macOS disclosure groups: collapsed by default, triangle rotates open */
  .sourcebar summary { list-style: none; cursor: pointer; font-size: 11px; font-weight: 700; color: var(--label2);
                      text-transform: uppercase; letter-spacing: .5px; padding: 2px 0 6px;
                      display: flex; align-items: center; gap: 6px; user-select: none; }
  .sourcebar details { margin-bottom: 16px; } /* native sidebar group rhythm */
  .sourcebar details:last-child { margin-bottom: 0; }
  .sourcebar summary::-webkit-details-marker { display: none; }
  .sourcebar summary::before { content: '▸'; color: var(--label3); font-size: 10px; line-height: 1;
                               transition: transform .15s ease; }
  .sourcebar details[open] > summary::before { transform: rotate(90deg); }
  .srow { display: flex; justify-content: space-between; align-items: baseline; padding: 5px 0; gap: 8px; }
  .srow .sv { font-weight: 600; }
  .sitem { padding: 5px 0 5px 16px; font-weight: 400; line-height: 1.3; color: var(--label2); }
  .spath { padding: 2px 0 6px 16px; }
  .spath .sl { display: block; font-size: 12px; color: var(--label2); }
  .spath .sv { display: block; color: var(--label2); font-size: 11px; word-break: break-all;
               margin-top: 1px; font-weight: 400; } /* paths are metadata: quiet */
  .spath.inline .sl { display: inline; margin-right: 10px; }
  .spath.inline .sv { display: inline; margin-top: 0; } /* short values sit beside the label */
  #rail { flex: 1; overflow-y: auto; min-height: 0; }
  .railhead { font-size: 11px; font-weight: 600; color: var(--label2); letter-spacing: .4px; text-transform: uppercase;
              margin: 2px 0 10px; display: flex; align-items: center; justify-content: space-between; }
  .wallbtn { font-size: 11px; font-weight: 500; border: .5px solid rgba(0,0,0,.18); border-radius: 5px;
             padding: 2px 9px; cursor: pointer; color: #1d1d1f;
             background: linear-gradient(#fff, #f0f0f0); box-shadow: 0 .5px .5px rgba(0,0,0,.04); }
  .wallbtn:hover { background: linear-gradient(#fff, #e8e8e8); }
  /* D17 app cards: their own zone under the system cards — header = drag handle + collapse toggle */
  .sec { font-size: 11px; font-weight: 600; color: var(--label2); letter-spacing: .4px; text-transform: uppercase; margin: 2px 0 10px; }
  .appgrid { display: flex; flex-direction: column; gap: 12px; }
  .appcard { background: var(--win); border-radius: 8px; overflow: hidden;
             box-shadow: 0 0 0 .5px rgba(0,0,0,.12); }
  .appcard.dragging { opacity: .4; }
  .apphead { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: grab;
             user-select: none; border-bottom: .5px solid var(--sep); }
  .appcard.collapsed .apphead { border-bottom: none; }
  .apphead h3 { margin: 0; flex: 0 0 auto; }
  .apptri { color: var(--label3); font-size: 10px; transition: transform .15s ease; }
  .appcard:not(.collapsed) .apptri { transform: rotate(90deg); }
  .appdesc { flex: 1; min-width: 0; color: var(--label2); font-size: 12px;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .appbody { padding: 10px 14px 12px; }
  .appcard.collapsed .appdesc, .appcard.collapsed .appbody { display: none; }
  /* routine x-monitor refresh ticks: inline tag stream, several per row */
  .tagrow { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .tag { font-size: 11px; color: var(--label2); background: rgba(120,120,128,.10); border-radius: 6px;
         padding: 2px 7px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* cards: iOS inset grouped lists */
  .card { background: var(--win); border-radius: 8px; padding: 14px 16px; grid-column: span 1;
          box-shadow: 0 0 0 .5px rgba(0,0,0,.10); }
  .card.wide { grid-column: 1 / -1; }
  h3 { font-size: 11px; font-weight: 600; color: var(--label2); letter-spacing: .4px; text-transform: uppercase; margin-bottom: 10px; }
  h3 .count { color: var(--label3); font-weight: 500; margin-left: 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 9px 10px; border-bottom: .5px solid var(--sep); vertical-align: top; }
  td:first-child { padding-left: 0; }   /* align to the card's 16px margin, Apple-style */
  td:last-child { padding-right: 0; }
  tr:last-child td { border-bottom: 0; }
  .mono { font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
  /* status: native macOS idiom — small dot + plain text, tabular numbers */
  .status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .sdot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px; }
  .sdot.ok   { background: var(--green); }
  .sdot.warn { background: var(--orange); }
  .sdot.err  { background: var(--red); }
  .sdot.off  { background: var(--label3); }
  .sdot.on   { background: var(--blue); }
  td, .stval, .ntime { font-variant-numeric: tabular-nums; }
  .activetab { border-left: 2px solid var(--blue); margin-left: -11px; padding-left: 9px; } /* hanging rule: text stays at column 0 */
  .muted { color: var(--label2); }
  /* notification banners: iOS notification spec — 40px icon, 18px radius */
  .notif { display: flex; gap: 10px; background: #fff; border-radius: 10px;
           box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 0 0 .5px rgba(0,0,0,.08);
           padding: 10px 12px; margin-bottom: 8px; }
  .notif.slidein { animation: slidein .42s cubic-bezier(.2,.9,.25,1); }
  @keyframes slidein { from { transform: translateX(70px); opacity: 0; } to { transform: none; opacity: 1; } }
  .notif .nicon { flex: 0 0 26px; width: 26px; height: 26px; border-radius: 7px; color: #fff;
                  display: flex; align-items: center; justify-content: center; }
  .notif.ok .nicon   { background: var(--green); }
  .notif.err .nicon  { background: var(--red); }
  .notif.info .nicon { background: var(--blue); }
  .notif .nbody { min-width: 0; }
  .notif .nhead { display: flex; align-items: baseline; gap: 6px; margin-bottom: 1px; }
  .notif .napp { font-size: 11px; color: var(--label2); font-weight: 600; }
  .notif .nhead .ntime { margin-left: auto; color: var(--label3); font-size: 11px; }
  .notif .nbody b.ntitle { display: none; }
  /* macOS-native notification header: muted app name + inline semibold title
     (NO colored chip badges) + right-aligned muted time; state color lives in
     the icon only, exactly like Notification Center */
  .ntit { font-size: 11px; font-weight: 500; color: #1d1d1f; white-space: nowrap; }
  .notif .nbody .ndetail { color: rgba(60,60,67,.85); font-size: 12px; line-height: 1.45; white-space: pre-line; }
  /* status card: iOS Settings rows */
  .stcard { background: rgba(255,255,255,.92); border-radius: 12px; padding: 11px 13px; margin-bottom: 10px;
            box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 0 0 .5px rgba(0,0,0,.04); }
  .stcard .sthead { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700;
                    padding-bottom: 8px; border-bottom: .5px solid var(--sep); margin-bottom: 2px; }
  .stcard .sthead svg { width: 15px; height: 15px; }
  .strow { display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
           padding: 6px 0; border-bottom: .5px solid var(--sep); font-size: 12.5px; }
  .strow:last-child { border-bottom: 0; }
  .strow .stlabel { color: var(--label2); }
  .strow .stval { font-weight: 400; text-align: right; }
  .pane { white-space: normal; word-break: break-all; padding-left: 10px; }
  .th { font-size: 11px; color: var(--label2); font-weight: 600; border-bottom: .5px solid var(--sep); padding-bottom: 5px; }
  .foot { flex: 0 0 26px; display: flex; align-items: center; justify-content: center;
          color: var(--label3); font-size: 11px; border-top: 1px solid var(--sep); }
  #ts { font-weight: 400; color: var(--label2); font-size: 11px; }
</style></head>
<body>
<div class="win">
  <div class="titlebar">
    <b>Browser Harness看板</b>
    <span class="mono" id="ts"></span>
  </div>
  <div class="layout">
    <aside class="sourcebar" id="source"></aside>
    <div class="split" id="srcsplit" title="部署信息"><span class="splitarr" id="srcarr">◂</span></div>
    <div class="main">
      <div class="grid" id="root"><div class="card">连接中…</div></div>
    </div>
    <div class="rightside">
      <section>
        <h2 class="sec" id="appsec" style="display:none">应用监控信息</h2>
        <div class="appgrid" id="appzone"></div>
      </section>
      <section class="railwrap">
        <div class="railhead"><span>应用实时事件</span><button id="wallbtn" type="button" class="wallbtn">开启墙提醒</button></div>
        <div id="rail"></div>
      </section>
    </div>
  </div>
</div>
<script>
window.__PAGEV = '__PAGEV_TOKEN__';
const dn = n => (n.startsWith('x-') && n !== 'x-intel') ? 'x-intel::' + n : n; // app::component namespacing
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// SF-Symbols-style vector glyphs (uniform 6-unit stroke, round caps)
const GLYPH_HSHOE = '<svg viewBox="0 0 48 48"><path fill="#fff" d="M30 5 L35 12 C41 14.5 44 20.5 44 28.5 L44 42 L12 42 C12 36 15 33 19 30.5 C23 28.5 22.5 24.5 19 26 C15.5 27.5 13.5 24 16.5 20.5 C20 15.5 24.5 9.5 30 5 Z"/><circle cx="30.5" cy="15.5" r="1.9" fill="#34c759"/></svg>';
const GLYPH_CHECK = '<svg viewBox="0 0 48 48"><path d="M10 25 L20 35 L38 13" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GLYPH_EXCL  = '<svg viewBox="0 0 48 48"><path d="M24 10 V27" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"/><circle cx="24" cy="38" r="4.2" fill="#fff"/></svg>';
// Native macOS status idiom: a small colored dot + PLAIN text. No capsules.
const pill = (v, cls = 'ok') => '<span class="status"><span class="sdot ' + cls + '"></span>' + esc(v) + '</span>';
// D16 wall alert: Chrome system notification on instance verdict edges (ok -> wall class).
// 127.0.0.1 is a secure context so Notification works without https; permission is
// granted once via the railhead button (Chrome wants a user gesture for the prompt).
const WALL_SET = { 'challenge-stuck': '挑战卡死', 'blocked': '被拦截', 'login-wall': '登录墙', 'asset-throttled': '资源阻断', 'blank': '白屏' };
function wallNotify(verdictZh, pageTitle, url, advice) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    const title = 'bh · ' + verdictZh;
    const body = [pageTitle, advice, url].filter(Boolean).join('\\n').slice(0, 180);
    const n = new Notification(title, {
      body: body || '站点拦截/验证：在浏览器窗口完成人工处理',
      tag: 'bh-wall-' + String(url || pageTitle || verdictZh).slice(0, 80),
      requireInteraction: true
    });
    n.onclick = () => { window.focus(); };
    return true;
  } catch { return false; }
}
window.__bhWallNotify = wallNotify;
function syncWallBtn() {
  const b = document.getElementById('wallbtn');
  if (b) b.style.display = (('Notification' in window) && Notification.permission === 'default') ? '' : 'none';
}
// localStorage helpers — D17 card order / collapse live per browser, server stays stateless
function lsGet(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
// D17 interactions: header click = collapse toggle, header drag = reorder (both persisted)
function bindAppCards() {
  const grid = document.getElementById('appzone');
  if (!grid) return;
  for (const card of grid.querySelectorAll('.appcard')) {
    const name = card.dataset.app;
    card.querySelector('.apphead').addEventListener('click', () => {
      card.classList.toggle('collapsed');
      const set = new Set(lsGet('bh-app-collapsed', []));
      if (card.classList.contains('collapsed')) set.add(name); else set.delete(name);
      lsSet('bh-app-collapsed', [...set]);
    });
    card.addEventListener('dragstart', e => {
      window.__appDragging = true;
      try { e.dataTransfer.setData('text/plain', name); } catch {}
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => { window.__appDragging = false; card.classList.remove('dragging'); });
  }
  if (grid.dataset.dragBound) return;
  grid.dataset.dragBound = '1';
  grid.addEventListener('dragover', e => e.preventDefault());
  grid.addEventListener('drop', e => {
    e.preventDefault();
    const src = e.dataTransfer.getData('text/plain');
    const cards = [...grid.querySelectorAll('.appcard')];
    const srcEl = cards.find(c => c.dataset.app === src);
    if (!srcEl) return;
    const ref = cards.find(c => {
      if (c === srcEl) return false;
      const b = c.getBoundingClientRect();
      return e.clientY < b.top + b.height / 2;
    });
    if (ref) grid.insertBefore(srcEl, ref); else grid.appendChild(srcEl);
    lsSet('bh-app-order', [...grid.querySelectorAll('.appcard')].map(c => c.dataset.app));
  });
}
function render(s) {
  // Page-code version handshake: SSE updates DATA only — a dashboard process
  // upgrade must not leave clients running the old page JS forever.
  if (s.pageV && window.__PAGEV && s.pageV !== window.__PAGEV) { location.reload(); return; }
  document.getElementById('ts').textContent = new Date(s.ts).toLocaleTimeString();
  // D16/D18 wall watch. Instances: edge-notify + banner (verdict is 30s-cached,
  // low churn). page-detect guardian tabs: banner = current state; their
  // NOTIFICATIONS come from the guardian's alerts stream, which is already
  // persistence-filtered (blank must persist across cycles — a navigation
  // flash is not an incident). The very first snapshot only baselines:
  // a dashboard reload must not replay standing walls.
  if (!window.__wallPrev) window.__wallPrev = {};
  if (!window.__wallActive) window.__wallActive = new Map();
  const wallEntries = [];
  for (const i of s.instances) {
    const v = i.verdict ? i.verdict.verdict : null;
    if (WALL_SET[v]) {
      const prev = window.__wallPrev[i.name];
      if (prev !== undefined && prev !== v) {
        wallNotify(WALL_SET[v], i.name, ((i.activeTab && i.activeTab.url) || ''), i.verdict.advice || '');
      }
      window.__wallPrev[i.name] = v;
      wallEntries.push({ key: i.name, label: i.name, verdict: v, advice: (i.verdict.advice || '') });
    } else {
      delete window.__wallPrev[i.name];
    }
  }
  for (const t of ((s.pageWatch && s.pageWatch.tabs) || [])) {
    if (WALL_SET[t.verdict]) {
      wallEntries.push({ key: 'tab:' + t.targetId, label: (t.title || t.url || '页面').slice(0, 44), verdict: t.verdict, advice: t.advice || '' });
    }
  }
  const pwAlerts = ((s.pageWatch && s.pageWatch.alerts) || []);
  if (!window.__pwNotified) {
    window.__pwNotified = new Set(pwAlerts.map(a => a.ts + '#' + a.targetId)); // baseline, no replay
  } else {
    for (const a of pwAlerts) {
      const k = a.ts + '#' + a.targetId;
      if (!window.__pwNotified.has(k)) {
        window.__pwNotified.add(k);
        wallNotify(WALL_SET[a.verdict] ?? a.verdict, String(a.title || '页面').slice(0, 44), String(a.url || '').slice(0, 80), a.advice || '');
      }
    }
    if (window.__pwNotified.size > 200) window.__pwNotified = new Set([...window.__pwNotified].slice(-100));
  }
  const wallKeys = new Set(wallEntries.map(e => e.key));
  for (const e of wallEntries) {
    if (!window.__wallActive.has(e.key)) window.__wallActive.set(e.key, { verdict: e.verdict, advice: e.advice, label: e.label, at: Date.now() });
    else window.__wallActive.get(e.key).verdict = e.verdict;
  }
  for (const k of [...window.__wallActive.keys()]) if (!wallKeys.has(k)) window.__wallActive.delete(k); // recovered: banner drops, no notification
  let h = '';
  // instances: full-width, five labelled columns, auto-spreading
  const VERDICT_ZH = { 'ok':'正常', 'challenge-stuck':'挑战卡死', 'network-stalled':'网络停滞', 'blocked':'被拦截', 'login-wall':'登录墙', 'blank':'空白页', 'asset-throttled':'资源限流' };
  h += '<div class="card wide"><h3>附着实例 <span class="count">'+s.instances.length+'</span></h3><table>';
  h += '<tr><td class="th">实例名</td><td class="th">端口</td><td class="th">进程</td><td class="th">状态</td><td class="th">运行时长</td><td class="th">操作中的 tab</td><td class="th">页面判定</td></tr>';
  for (const i of s.instances) {
    // default / page-detect idle without a pinned tab is 待命 (lazy attach).
    // 已脱离 is for a named worker that lost its tab. Down default is still 待命.
    const state = i.alive
      ? (i.activeTab ? pill('已附着', 'on')
        : (i.name === 'default' || i.name === 'page-detect' ? pill('待命', 'off') : pill('已脱离', 'warn')))
      : (i.name === 'default' ? pill('待命', 'off') : pill('已停止', 'err'));
    h += '<tr><td style="white-space:nowrap"><b>'+esc(i.name)+'</b></td>'+
         '<td class="mono muted">:'+i.port+'</td>'+
         '<td class="mono muted">'+(i.alive && i.pid ? 'pid '+i.pid : '—')+'</td>'+
         '<td>'+state+'</td>'+
         '<td class="mono" >'+(i.uptime != null ? Math.floor(i.uptime/60) + '分' + (i.uptime%60) + '秒' + (i.replacements ? '（自愈 ' + i.replacements + '）' : '') : '—')+'</td>';
    h += '<td style="min-width:220px">';
    if (i.activeTab) {
      h += '<div class="mono activetab">'+(i.activeTab.marked?'🐴 ':'')+ '<b>'+esc((i.activeTab.title||'(无标题)').slice(0,40))+'</b>'+
           ' <span class="muted">'+esc(i.activeTab.url.slice(0,56))+'</span></div>';
    } else {
      h += '<span class="muted">'+esc(i.error || '（未附着）')+'</span>';
    }
    h += '</td>';
    if (i.verdict) {
      const vc = { 'ok':'ok', 'challenge-stuck':'warn', 'network-stalled':'warn', 'login-wall':'warn', 'blocked':'err', 'blank':'err', 'asset-throttled':'err' }[i.verdict.verdict] ?? 'warn';
      h += '<td style="white-space:nowrap">'+pill(VERDICT_ZH[i.verdict.verdict] ?? i.verdict.verdict, vc)+(i.verdict.advice ? '<br><span class="muted">'+esc(i.verdict.advice.slice(0,26))+'</span>' : '')+'</td>';
    }
    else h += '<td></td>';
    h += '</tr>';
  }
  h += '</table></div>';
  // 应用监控台 (D17/D18): guardian (resident) apps only. ONE uniform template:
  // every card renders the app's self-published status contract
  // (data/<app>.status.json: state + metrics[] + event) — no per-app branches.
  const apps = s.apps || { appNames: [], desc: {}, resident: {}, status: {}, runs: [], caches: {} };
  const wkr = s.worker || {};
  const residentNames = (apps.appNames || []).filter(n => (apps.resident || {})[n]);
  const savedOrder = lsGet('bh-app-order', []).filter(n => residentNames.includes(n));
  const appOrder = savedOrder.concat(residentNames.filter(n => !savedOrder.includes(n)));
  const collapsedSet = new Set(lsGet('bh-app-collapsed', []));
  let appsHtml = '';
  for (const n of appOrder) {
    const st = (apps.status || {})[n] || null;
    const stateLabel = !st || st.state === 'stopped' ? '未运行' : (st.state === 'degraded' ? '异常' : '运行中');
    const stateCls = stateLabel === '运行中' ? 'ok' : (stateLabel === '异常' ? 'err' : 'off');
    appsHtml += '<div class="appcard' + (collapsedSet.has(n) ? ' collapsed' : '') + '" draggable="true" data-app="' + esc(n) + '">'
      + '<div class="apphead"><span class="apptri">▸</span><h3>' + esc(n) + '</h3>'
      + '<span class="appdesc">' + esc((apps.desc && apps.desc[n]) || '（无描述）') + '</span>'
      + '<span style="white-space:nowrap">' + pill(stateLabel, stateCls) + '</span></div>'
      + '<div class="appbody">';
    for (const m of ((st && st.metrics) || [])) {
      appsHtml += '<div class="strow"><span class="stlabel">' + esc(m.label) + '</span><span class="stval">' + esc(m.value) + '</span></div>';
    }
    if (st && st.event && st.event.text && st.event.kind !== 'tick') {
      appsHtml += '<div class="strow"><span class="stlabel">最近事件</span><span class="stval mono" style="font-size:11px">' + esc(String(st.event.text).slice(0, 46)) + '</span></div>';
    }
    appsHtml += '</div></div>';
  }
  // global attach surface: every open tab of the attached browser, with ownership
  const byTarget = new Map();
  for (const i of s.instances) {
    for (const t of (i.tabs||[])) {
      let row = byTarget.get(t.targetId);
      if (!row) { row = { url: t.url, title: t.title, marked: t.marked, by: [] }; byTarget.set(t.targetId, row); }
      if (t.active) row.by.push(i.name);
      if (t.marked) row.marked = true;
    }
  }
  h += '<div class="card wide"><h3>浏览器状态 <span class="count">'+byTarget.size+'</span></h3><table>';
  h += '<tr><td class="th" style="width:130px">状态</td><td class="th" style="width:280px">标题</td><td class="th">网址</td></tr>';
  for (const row of byTarget.values()) {
    const chip = row.by.length
      ? pill(row.by.join('、') + ' 操作中', 'on')
      : pill('未附着', 'off');
    h += '<tr><td>'+chip+'</td>'+
         '<td class="mono">'+(row.marked?'🐴 ':'')+esc((row.title||'(无标题)').slice(0,44))+'</td>'+
         '<td class="mono muted" style="word-break:break-all">'+esc(row.url)+'</td></tr>';
  }
  if (!byTarget.size) h += '<tr><td><span class="muted">（无已附着实例——浏览器未被任何 bh 实例附着）</span></td></tr>';
  h += '</table></div>';
  // rmux: sessions as labelled table rows
  const r = s.rmux || {};
  h += '<div class="card wide"><h3>rmux工作台情况 <span class="count">'+((r.sessions||[]).length)+'</span></h3><table>';
  h += '<tr><td class="th" style="width:120px">会话</td><td class="th" style="width:110px">进程</td><td class="th">命令行（原生命令与参数）</td></tr>';
  for (const ses of (r.sessions||[])) {
    for (const p of (ses.panes||[])) {
      // The NATIVE command line, arguments included — exactly what the OS ran.
      const cl = String(p.commandLine||'').trim();
      const fallback = String(p.command||'').replace(/"/g,'').trim();
      h += '<tr><td style="white-space:nowrap"><b class="mono">'+esc(ses.name)+'</b></td>'+
           '<td class="mono muted" style="white-space:nowrap">'+(p.pid ? 'pid '+esc(p.pid) : '—')+'</td>'+
           '<td class="mono" style="word-break:break-all;color:#48484c" title="'+esc(cl || fallback)+'">'+esc(cl || fallback)+(cl ? '' : ' · '+esc(p.path||''))+'</td></tr>';
    }
  }
  if (!(r.sessions||[]).length) h += '<tr><td colspan="3"><span class="muted">（无会话）</span></td></tr>';
  h += '</table></div>';
  // 右侧日志栏：纯日志横幅（x-monitor 与 page-detect 双源；守护状态在应用监控台卡内）
  let rail = '';
  // 累加历史：新条目追加进浏览器侧数组，最多留 100 条，显示最新 10 条
  if (!window.__logAll) window.__logAll = [];
  const lines = [...(wkr.logTail || []), ...(wkr.pageLogTail || [])];
  const fresh = [];
  {
    const entries0 = [];
    for (const l of lines.slice(-24)) {
      if (/^\\[/.test(l)) entries0.push(l);
      else if (entries0.length) entries0[entries0.length - 1] += '\\n' + l;
    }
    for (const e of entries0) if (!window.__logAll.includes(e)) { window.__logAll.push(e); fresh.push(e); }
    if (window.__logAll.length > 100) window.__logAll.splice(0, window.__logAll.length - 100);
  }
  // D16: active wall banners pinned at the rail top (in-page counterpart of the
  // system notification; stays until the verdict clears)
  for (const [name, we] of window.__wallActive) {
    const justIn = Date.now() - we.at < 3000;
    rail += '<div class="notif err'+(justIn?' slidein':'')+'">'+
         '<div class="nicon">'+GLYPH_EXCL+'</div>'+
         '<div class="nbody"><div class="nhead"><span class="napp">'+esc(we.label || name)+'</span><span class="ntit">'+esc(WALL_SET[we.verdict] ?? we.verdict)+'</span><span class="ntime">'+new Date(we.at).toTimeString().slice(0,8)+'</span></div>'+
         '<div class="ndetail">'+esc(we.advice || '站点拦截/验证：在浏览器窗口完成人工处理后自动恢复')+'</div></div></div>';
  }
  // 累加日志的展示：默认只显最新 10 条（内部继续累加，上限 100）
  for (const e of window.__logAll.slice(-10).reverse()) {
    const m = /^\\[([0-9:]+)\\]\\s*([\\s\\S]*)$/.exec(e) || [null,'',e];
    const time = m[1] ?? '', body = m[2] ?? e;
    const src = dn(body.includes('page-detect') ? 'page-detect' : 'x-monitor');
    let cls = 'info', icon = GLYPH_CHECK, title = '消息';
    if (body.includes('告警')) { cls='err'; icon=GLYPH_EXCL; title='告警'; }
    else if (body.includes('刷新失败')) { cls='err'; icon=GLYPH_EXCL; title='刷新失败'; }
    else if (body.includes('巡检')) { cls='ok'; icon=GLYPH_CHECK; title='巡检'; }
    else if (body.includes('刷新')) { cls='ok'; icon=GLYPH_CHECK; title='刷新'; }
    else if (body.includes('启动')) { cls='info'; icon=GLYPH_CHECK; title='启动'; }
    let detail = body.includes('\\n') ? body.slice(body.indexOf('\\n') + 1) : body.replace(/^.*?：/, '');
    // 刷新横幅只显三行指标；库存/时间线由监控台状态卡承载，不在横幅重复
    if (cls === 'ok') detail = detail.split('\\n').slice(0, 3).join('\\n');
    const isNew = fresh.includes(e);
    rail += '<div class="notif '+cls+(isNew?' slidein':'')+'">'+
         '<div class="nicon">'+icon+'</div>'+
         '<div class="nbody"><div class="nhead"><span class="napp">'+esc(src)+'</span><span class="ntit">'+esc(title)+'</span><span class="ntime">'+esc(time)+'</span></div>'+
         '<div class="ndetail">'+esc(detail.slice(0,220))+'</div></div></div>';
  }
  // Wholesale re-assign only when markup changed — a mid-drag re-render would
  // destroy the drag operation (2s SSE would otherwise do exactly that).
  if (window.__rootHtml !== h && !window.__appDragging) {
    window.__rootHtml = h;
    document.getElementById('root').innerHTML = h;
  }
  // App zone (right side, top): its own change guard — independent of #root
  if (window.__appsHtml !== appsHtml && !window.__appDragging) {
    window.__appsHtml = appsHtml;
    document.getElementById('appzone').innerHTML = appsHtml;
    document.getElementById('appsec').style.display = appOrder.length ? '' : 'none';
    bindAppCards();
  }
  document.getElementById('rail').innerHTML = rail;
  // 左栏：安装与资源状态——macOS 折叠组。SSE 每 2 秒重渲染会丢展开态：
  // 先记住哪些组是开的；内容没变就整个跳过（60 秒缓存内通常稳定）。
  const a = s.assets || {};
  if (!window.__srcOpen) window.__srcOpen = new Set(['install', 'dirs']);
  for (const d of document.querySelectorAll('#source details')) {
    if (d.open) window.__srcOpen.add(d.dataset.k ?? '');
    else window.__srcOpen.delete(d.dataset.k ?? '');
  }
  const isOpen = (k) => window.__srcOpen.has(k) ? ' open' : '';
  let src = '';
  src += '<details data-k="install"'+isOpen('install')+'><summary>安装</summary>';
  src += '<div class="spath inline"><span class="sl">版本</span><span class="mono sv">'+esc(a.version)+'</span></div>';
  src += '<div class="spath inline"><span class="sl">模式</span><span class="mono sv">'+esc(a.mode)+'</span></div>';
  src += '<div class="spath"><span class="sl">BH 安装目录</span><span class="mono sv">'+esc(a.installDir)+'</span></div>';
  src += '</details>';
  src += '<details data-k="dirs"'+isOpen('dirs')+'><summary>目录</summary>';
  src += '<div class="spath"><span class="sl">应用目录</span><span class="mono sv">'+esc(a.workspaceDir)+'</span></div>';
  src += '<div class="spath"><span class="sl">数据目录</span><span class="mono sv">'+esc(a.dataDir)+'</span></div>';
  for (const l of (a.skillLines||[])) src += '<div class="spath"><span class="sl">'+esc(l.tool)+' SKILL</span><span class="mono sv">'+esc(l.dir)+'</span></div>';
  src += '</details>';
  src += '<details data-k="apps"'+isOpen('apps')+'><summary>应用 <span class="muted" style="font-weight:400">'+((a.appNames||[]).length)+'</span></summary>';
  for (const n of (a.appNames||[])) src += '<div class="sitem">'+esc(n)+'</div>';
  src += '</details>';
  src += '<details data-k="stats"'+isOpen('stats')+'><summary>SKILL 资产</summary>';
  src += '<div class="spath inline"><span class="sl">交互配方</span><span class="mono sv">'+((a.interaction||[]).length)+' 篇</span></div>';
  src += '<div class="spath inline"><span class="sl">站点知识</span><span class="mono sv">'+esc(a.sites)+' 个网站</span></div>';
  src += '</details>';
  if (window.__srcHtml !== src) { window.__srcHtml = src; document.getElementById('source').innerHTML = src; }
  syncWallBtn();
}
document.getElementById('wallbtn').onclick = async () => {
  try {
    const p = await Notification.requestPermission();
    syncWallBtn();
    if (p === 'granted') wallNotify('提醒已开启', 'bh 看板', '', '此后遇墙将以系统通知提醒你');
  } catch { /* prompt dismissed */ }
};
function setSrcbarHidden(hidden) {
  const layout = document.querySelector('.layout');
  const arr = document.getElementById('srcarr');
  if (layout) layout.classList.toggle('nosource', hidden);
  if (arr) arr.textContent = hidden ? '▸' : '◂';
  lsSet('bh-srcbar-hidden', hidden);
}
document.getElementById('srcsplit').onclick = () => {
  const layout = document.querySelector('.layout');
  if (!layout) return;
  setSrcbarHidden(!layout.classList.contains('nosource'));
};
setSrcbarHidden(lsGet('bh-srcbar-hidden', true));
const es = new EventSource('/events');
es.onmessage = ev => { try { render(JSON.parse(ev.data)); } catch {} };
</script>
</body></html>`;

/**
 * Idempotent dashboard bring-up. Probes first (a taken port or an
 * already-running board is a no-op), spawns detached otherwise.
 */
export async function ensureDashboard(): Promise<'up' | 'spawned'> {
  const alive = async () => {
    try { const r = await fetch(`http://127.0.0.1:${DASHBOARD_PORT}`, { signal: AbortSignal.timeout(1000) }); return r.ok; } catch { return false; }
  };
  if (await alive()) return 'up';
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./dashboard.js', import.meta.url))], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await alive()) return 'spawned';
    await new Promise(r => setTimeout(r, 250));
  }
  return 'spawned'; // spawn issued; liveness beyond this window is the board's own business
}

export function startDashboard(): void {
  const clients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE.replace('__PAGEV_TOKEN__', pageVersion()));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      void snapshot().then(s => res.end(JSON.stringify(s)));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  server.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    console.log(JSON.stringify({ ok: true, dashboard: true, port: DASHBOARD_PORT, url: `http://127.0.0.1:${DASHBOARD_PORT}` }));
    void (async () => {
      for (;;) {
        const s = await snapshot().catch(e => ({ ts: new Date().toISOString(), error: String(e) }));
        for (const c of clients) c.write(`data: ${JSON.stringify(s)}\n\n`);
        await sleep(1000);
      }
    })();
  });
  server.on('error', (e: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ ok: false, error: String(e.code ?? e.message) }));
    process.exit(1);
  });
}

// Entry when run directly: node dist/dashboard.js
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('dist', 'dashboard.js'))) {
  startDashboard();
}
