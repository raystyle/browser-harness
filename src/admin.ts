/**
 * Management plane: doctor, ensureDaemon, restartDaemon, chrome-mode.
 *
 * Error messages are instructions for the calling agent, not stack traces
 * (`bh: <next step>` → stderr + exit 1). doctor --json is a stable machine
 * channel; --require-existing-daemon is strict fail-closed: it never starts,
 * repairs, or discovers beyond the already-running instance.
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstanceRecord, instanceName, derivedPort, logFile, homeDir, runtimeDir, DEFAULT_NAME, workspaceDir } from './paths.js';
import { isDevCheckout } from './paths.js';
import { agentChromeHeadless, agentCdpUrl, chromeBinary, isAgentChromeRunning, launchAgentChrome, stopAgentChrome } from './agentChrome.js';
import { envSetDefault } from './env.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

export type HealthInfo = {
  ok: boolean; uptime?: number; connected?: boolean; sessionId?: string | null;
  name?: string; pid?: number; version?: string; headless?: boolean;
};

/** GET /health on a REPL instance. */
export async function health(port: number, timeoutMs = 1000): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json() as HealthInfo;
  } catch {
    return null;
  }
}

/** POST /eval on a REPL instance; returns parsed JSON result or throws with the stderr text. */
export async function evalOn<T = unknown>(port: number, code: string, timeoutMs?: number): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}/eval`, {
    method: 'POST', body: code,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(body.trim().split('\n')[0] ?? `eval failed (${res.status})`);
  if (!body.trim()) return undefined as T;
  try { return JSON.parse(body) as T; } catch { return body as unknown as T; }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export function installMode(): 'dev' | 'npm-link' | 'npm-global' {
  if (isDevCheckout()) return 'dev';
  try {
    return realpathSync(DIST_DIR) === path.resolve(DIST_DIR) ? 'npm-global' : 'npm-link';
  } catch {
    return 'npm-global';
  }
}

function packageVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(path.dirname(DIST_DIR), 'package.json'), 'utf8')).version as string;
  } catch {
    return 'unknown';
  }
}

/** Chrome-ish browser process running? By process NAME only for the passive check (never for killing). */
function chromeRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' });
      const out = String(r.stdout ?? '');
      return /chrome\.exe/i.test(out) || (() => {
        const e = spawnSync('tasklist', ['/FI', 'IMAGENAME eq msedge.exe'], { timeout: 10_000, windowsHide: true, encoding: 'utf8' });
        return /msedge\.exe/i.test(String(e.stdout ?? ''));
      })();
    }
    const r = spawnSync('ps', ['-A', '-o', 'comm='], { timeout: 10_000, encoding: 'utf8' });
    return /((google)?[c]hrome|chromium|msedge|Microsoft Edge)$/im.test(String(r.stdout ?? ''));
  } catch {
    return false;
  }
}

function rmuxInfo(): { installed: boolean; version?: string; path?: string } {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env['LOCALAPPDATA'] ?? '', 'rmux', 'bin', 'rmux.exe')]
    : [];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const r = spawnSync(c, ['-V'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
        return { installed: true, version: String(r.stdout ?? '').trim() || undefined, path: c };
      } catch { /* fall through */ }
    }
  }
  try {
    const r = spawnSync('rmux', ['-V'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) return { installed: true, version: String(r.stdout ?? '').trim() || undefined, path: 'rmux (PATH)' };
  } catch { /* not installed */ }
  return { installed: false };
}

/** Enumerate running instances from the runtime registry. */
function instanceNames(): string[] {
  const out = new Set<string>([DEFAULT_NAME]);
  try {
    for (const f of readdirSync(runtimeDir())) {
      const m = /^bh-(.+)\.port$/.exec(f);
      if (m) out.add(m[1] ?? '');
    }
  } catch { /* runtime dir empty */ }
  return [...out].filter(Boolean);
}

export type DoctorCheck = { name: string; ok: boolean; detail: string };
export type DoctorResult = {
  checks: DoctorCheck[];
  healthy: boolean;
  header: Record<string, string>;
};

// ---------------------------------------------------------------------------
// sessions: object model (as the code defines it) + live inventory
// ---------------------------------------------------------------------------

/** The browser object model, distilled from the code that operates it. */
export const BROWSER_OBJECT_MODEL: Record<string, string> = {
  instance: 'BH_NAME 命名空间：端口/profile/workspace 按 name 派生（paths.ts 实例注册表 bh-<name>.port，default 写 bh.port）；task-<hex8> 隔离任务也是实例',
  browser: '一个 Chrome 进程树：agent Chrome（归属记录 bh-agent.json，ensure_app_sdk 的 tab 住这里）或 task 隔离实例；daemon 经 Session 连其 browser endpoint',
  session: 'Session（session.ts）：到 browser endpoint 的一条持久 WebSocket（flatten：全部 target session 共享一线）；activeSessionId 记活动 target，每次 cdp 调用自动注入 sessionId——这是路由的唯一机制',
  tab: 'type=page 的 CDP target（页签）。操作面（helpers.ts）：switch_tab(target, activate=false) 附着不抢前台 / activate_tab 前台激活 / new_tab(url 默认 about:blank) / close_tab / list_tabs',
  placeholder: '_is_agent_startup_placeholder：about:blank 类启动占位页不算真 tab；ensure_real_tab 保证操作落在真页上',
  window: 'CDP windowId 存在但 helpers 层无窗口操作原语——窗口不是 bh 的一等对象；new_tab 落在当前窗口',
  navigation: 'goto_url = 地址栏输入的编程等价（Page.navigate + 等待判官 adjudicate_lost_navigation）',
};

/** Where a NEW task lands, per entry path — attach vs new tab vs isolated stack. */
export const ATTACH_POLICY: Record<string, string> = {
  "bh '<js>'": 'attach：在活动 target 上执行（上一个 switch_tab/use 保持的；ensure_real_tab 兜底占位页）',
  'app (plugins)': 'attach：ensure_app_tab 按 host 一 app 一 tab 复用，不存在才 new_tab',
  "bh --new-tab '<js>'": 'explicit：new_tab(about:blank) 后附着执行，tab 保持打开（新原语）',
  'bh --once/--batch': 'isolated：task-<hex8> 独立实例（克隆登录 profile + 内核保留端口），任务结束即拆',
};

export type SessionsTab = { targetId: string; url: string; title: string };
export type SessionsWindow = { windowId: number | null; tabs: SessionsTab[] };
export type SessionsInstance = {
  name: string;
  daemon: { alive: boolean; port: number; pid?: number; cdp: boolean };
  windows: SessionsWindow[];
};
export type SessionsResult = {
  model: Record<string, string>;
  attachPolicy: Record<string, string>;
  instances: SessionsInstance[];
};

/**
 * Live inventory across every registered instance: daemon liveness, CDP
 * session state, and the tab table grouped by CDP windowId. Read-only —
 * never starts, attaches, or launches anything.
 */
export async function runSessions(): Promise<SessionsResult> {
  const instances: SessionsInstance[] = [];
  for (const inst of instanceNames()) {
    const rec = readInstanceRecord(inst);
    if (!rec) continue;
    const h = await health(rec.port, 800);
    const entry: SessionsInstance = {
      name: inst,
      daemon: { alive: !!h?.ok, port: rec.port, pid: rec.pid, cdp: !!h?.connected },
      windows: [],
    };
    if (h?.ok && h?.connected) {
      try {
        const tabs = await evalOn<Array<{ targetId: string; url: string; title: string; windowId: number | null }>>(rec.port,
          'return await (async () => { const ts = (await session.domains.Target.getTargets({})).targetInfos.filter(t => t.type === "page"); const out = []; for (const t of ts) { let w = null; try { w = (await session.domains.Browser.getWindowForTarget({ targetId: t.targetId })).windowId } catch {} out.push({ targetId: t.targetId, url: t.url, title: t.title, windowId: w }) } return out })()');
        const byWin = new Map<number | null, SessionsTab[]>();
        for (const t of tabs ?? []) {
          const k = typeof t.windowId === 'number' ? t.windowId : null;
          if (!byWin.has(k)) byWin.set(k, []);
          byWin.get(k)!.push({ targetId: t.targetId, url: t.url, title: t.title });
        }
        entry.windows = [...byWin.entries()].map(([windowId, wt]) => ({ windowId, tabs: wt }));
      } catch { /* CDP dead on this instance — windows stays [] */ }
    }
    instances.push(entry);
  }
  return { model: BROWSER_OBJECT_MODEL, attachPolicy: ATTACH_POLICY, instances };
}

export async function runDoctor(opts: { requireExistingDaemon?: boolean } = {}): Promise<DoctorResult> {
  const header = {
    platform: process.platform,
    node: process.version,
    version: `${packageVersion()} (${installMode()})`,
  };
  const checks: DoctorCheck[] = [];

  // chrome running (passive name check)
  checks.push({ name: 'chrome running', ok: chromeRunning(), detail: chromeRunning() ? 'browser process present' : 'no chromium process found' });

  // daemon alive — health + (non-strict) real-CDP confirmation
  const name = instanceName();
  const port = derivedPort();
  const h = await health(port);
  let daemonOk = !!h?.ok && h?.name === name;
  let daemonDetail = daemonOk ? `instance "${name}" on :${port}` : `instance "${name}" not answering on :${port}`;
  if (daemonOk && !opts.requireExistingDaemon) {
    try {
      const n = await evalOn<number>(port, 'return (await session.domains.Target.getTargets({})).targetInfos.length');
      daemonDetail = `instance "${name}" on :${port}, ${n} targets`;
    } catch (e: any) {
      daemonOk = false;
      daemonDetail = `daemon answers but CDP is dead (${String(e?.message ?? e).slice(0, 80)})`;
    }
  }
  checks.push({ name: 'daemon alive', ok: daemonOk, detail: daemonDetail });

  // browser connections — per-instance informational
  const conns: string[] = [];
  let anyConnected = false;
  for (const inst of instanceNames()) {
    const rec = readInstanceRecord(inst);
    if (!rec) continue;
    const ih = await health(rec.port, 800);
    if (!ih?.ok) continue;
    if (ih.connected) {
      anyConnected = true;
      let page = '(no page info)';
      try {
        const info = await evalOn<{ url?: string; title?: string }>(rec.port, 'try { return await session.domains.Target.getTargetInfo({}).then ? undefined : undefined } catch { return undefined }');
        page = info?.url ? `${(info.title ?? '').slice(0, 40)} — ${info.url.slice(0, 60)}` : page;
      } catch { /* page info optional */ }
      conns.push(`${inst} — active page: ${page}`);
    } else {
      conns.push(`${inst} — (no real page)`);
    }
  }
  checks.push({ name: 'browser connections', ok: anyConnected, detail: conns.length ? conns.join(' | ') : 'none' });

  // rmux (informational in P1; becomes a judged row when x-monitor ships)
  const rmux = rmuxInfo();
  checks.push({ name: 'rmux', ok: true, detail: rmux.installed ? `${rmux.version ?? 'installed'} (${rmux.path})` : 'not installed (only needed for x-monitor)' });

  // ffmpeg (informational — video export degrades to an HTML slideshow without it)
  let ffmpegDetail = 'not installed (video export degrades to HTML slideshow)';
  try {
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) ffmpegDetail = String(r.stdout ?? '').split('\n')[0]?.trim() ?? 'installed';
  } catch { /* absent */ }
  checks.push({ name: 'ffmpeg', ok: true, detail: ffmpegDetail });

  const coreOk = checks[0]?.ok === true && checks[1]?.ok === true; // chrome + daemon
  const healthy = opts.requireExistingDaemon
    ? daemonOk && (anyConnected || true) // strict: daemon must be alive; browser_ready refined in P2
    : coreOk;
  return { checks, healthy, header };
}

// ---------------------------------------------------------------------------
// ensureDaemon / restartDaemon
// ---------------------------------------------------------------------------

function spawnRepl(name: string, port: number): void {
  const log = logFile(name);
  const fd = openSync(log, 'w');
  const child = spawn(process.execPath, [path.join(DIST_DIR, 'repl.js')], {
    detached: true, windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, BH_NAME: name, CDP_REPL_PORT: String(port) },
  });
  child.unref();
  closeSync(fd);
}

function logTail(name: string, lines = 5): string {
  try {
    const raw = readFileSync(logFile(name), 'utf8').trim();
    if (!raw) return '';
    return raw.split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Idempotent: bring the REPL instance for the current BH_NAME up, confirming
 * real CDP readiness (a daemon whose WebSocket died still answers /health).
 * Errors are classified from the log tail and phrased as agent instructions.
 */
export async function ensureDaemon(): Promise<void> {
  const name = instanceName();
  const port = derivedPort();
  const h = await health(port);
  if (h?.ok && h.name === name) {
    try {
      await evalOn(port, 'return (await session.domains.Target.getTargets({})).targetInfos.length');
      return; // alive AND CDP-ready
    } catch { /* stale: fall through to restart */ }
  }
  for (let round = 0; round < 3; round++) {
    spawnRepl(name, port);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(300);
      const hh = await health(port, 800);
      if (hh?.ok && hh.name === name) return;
      const tail = logTail(name, 1).toLowerCase();
      if (tail.includes('permission-blocked')) {
        throw new Error(`permission-blocked: Chrome is showing the "Allow remote debugging?" prompt — ask the user to click Allow, then retry. Do not retry before they confirm.`);
      }
      if (tail.includes('eaddrinuse')) break; // another spawn won it; verify below
    }
    const hh = await health(port);
    if (hh?.ok && hh.name === name) return;
  }
  throw new Error(`daemon "${name}" didn't come up on :${port} — check ${logFile(name)} (tail: ${logTail(name) || 'empty'})`);
}

/** Process start-time fingerprint — protects stop from PID reuse. */
function processStartTime(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToString('o')`], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
      const out = String(r.stdout ?? '').trim();
      return out || undefined;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      return afterComm.split(' ')[19]; // field 22 overall
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 8000, encoding: 'utf8' });
    const out = String(r.stdout ?? '').trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stop the current instance, verifying identity before any signal: only a
 * process that still matches the recorded pid AND start-time fingerprint is
 * killed.
 */
export async function restartDaemon(): Promise<void> {
  const name = instanceName();
  const port = derivedPort();
  const h = await health(port);
  if (h?.ok) {
    try {
      await fetch(`http://127.0.0.1:${port}/quit`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    } catch { /* already gone */ }
  }
  const rec = readInstanceRecord(name);
  if (rec && rec.pid !== process.pid) {
    const t0 = processStartTime(rec.pid);
    for (let i = 0; i < 75; i++) {
      await sleep(200);
      let alive = false;
      try { process.kill(rec.pid, 0); alive = true; } catch { alive = false; }
      if (!alive) break;
      if (i === 74) {
        // Still alive — kill only if it is demonstrably the same process.
        const t1 = processStartTime(rec.pid);
        if (t0 !== undefined && t1 === t0) {
          try { process.kill(rec.pid, 'SIGTERM'); } catch { /* raced away */ }
        } else {
          throw new Error(`refusing to kill pid ${rec.pid}: identity mismatch (PID reuse suspected)`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// chrome-mode
// ---------------------------------------------------------------------------

/** Write a key into <BH_HOME>/.env (in-place line replace or append). The .env is the single source of truth. */
export function setEnvValue(key: string, value: string): void {
  const p = path.join(homeDir(), '.env');
  mkdirSync(path.dirname(p), { recursive: true });
  const lines = existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*(export\\s+)?${key}=`);
  const idx = lines.findIndex(l => re.test(l) && !l.trim().startsWith('#'));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(p, lines.join('\n').replace(/\n*$/, '\n'), 'utf8');
}

/** Best-effort silence of the x-monitor supervision chain before a chrome-mode flip. */
async function silenceXMonitor(): Promise<void> {
  try {
    const mod = await import('./rmux.js') as { Rmux?: new () => { killSession(n: string): Promise<void>; killServer(): Promise<void> } };
    if (!mod.Rmux) return;
    const r = new mod.Rmux();
    await r.killSession('x-monitor').catch(() => {});
    await r.killSession('x-supervisor').catch(() => {});
  } catch { /* rmux module or binary absent — nothing to silence */ }
}

export async function runChromeMode(mode: 'on' | 'off' | 'status'): Promise<number> {
  if (mode === 'status') {
    const envVal = process.env.BH_CHROME_HEADLESS ?? '(unset — auto)';
    const actual = await agentChromeHeadless();
    console.log(`BH_CHROME_HEADLESS=${envVal}`);
    console.log(`browser reports: ${actual === undefined ? 'not running' : actual ? 'headless' : 'headed'}`);
    return 0;
  }
  setEnvValue('BH_CHROME_HEADLESS', mode === 'on' ? '1' : '0');
  process.env.BH_CHROME_HEADLESS = mode === 'on' ? '1' : '0';
  // Flip order (v0.6.10): silence supervised workers FIRST — a live worker that
  // sees its daemon die would resurrect Chrome in the old mode and race ours.
  await silenceXMonitor();
  await restartDaemon();
  await stopAgentChrome();
  await launchAgentChrome();
  await ensureDaemon();
  const actual = await agentChromeHeadless();
  const want = mode === 'on';
  if (actual !== want) {
    process.stderr.write(`bh: chrome-mode flip to ${mode} did not verify (browser reports ${actual === undefined ? 'not running' : actual}) — check ${logFile(instanceName())}\n`);
    return 1;
  }
  console.log(`chrome-mode: ${mode} verified`);
  return 0;
}
