/**
 * Management plane: doctor, ensureDaemon, restartDaemon.
 *
 * Error messages are instructions for the calling agent, not stack traces
 * (`bh: <next step>` → stderr + exit 1). doctor --json is a stable machine
 * channel; --require-existing-daemon is strict fail-closed: it never starts,
 * repairs, or discovers beyond the already-running instance.
 */

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstanceRecord, instanceName, derivedPort, logFile, homeDir, runtimeDir, DEFAULT_NAME, workspaceDir, dataDir } from './paths.js';
import { isDevCheckout } from './paths.js';
import { detectBrowsers, getBrowserCandidates } from './session.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

export type HealthInfo = {
  ok: boolean; uptime?: number; connected?: boolean; sessionId?: string | null;
  name?: string; pid?: number; version?: string; buildTime?: number;
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
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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

/**
 * Attachable browser check: a Chromium profile with remote debugging enabled
 * (DevToolsActivePort present — the chrome://inspect/#remote-debugging
 * toggle channel). This is the D11 health signal; Edge is never scanned.
 */
async function browserAttachable(): Promise<{ ok: boolean; detail: string }> {
  const found = await detectBrowsers();
  if (found.length > 0) {
    return { ok: true, detail: found.map(b => `${b.name} @ ${b.wsUrl}`).join(' | ') };
  }
  return {
    ok: false,
    detail: `none — enable it: open your Chrome, visit chrome://inspect/#remote-debugging, enable "Allow remote debugging for this browser instance" (scanned: ${getBrowserCandidates().map(c => c.name).join(', ')})`,
  };
}

function rmuxInfo(): { installed: boolean; version?: string; path?: string } {
  const candidates = process.platform === 'win32'
    ? [path.join(process.env['LOCALAPPDATA'] ?? '', 'rmux', 'bin', 'rmux.exe')]
    : [];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        const r = spawnSync(c, ['-V'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
        const version = String(r.stdout ?? '').trim();
        return { installed: true, ...(version ? { version } : {}), path: c };
      } catch { /* fall through */ }
    }
  }
  try {
    const r = spawnSync('rmux', ['-V'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) {
      const version = String(r.stdout ?? '').trim();
      return { installed: true, ...(version ? { version } : {}), path: 'rmux (PATH)' };
    }
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
  instance: 'BH_NAME 命名空间：端口/workspace 按 name 派生（paths.ts 实例注册表 bh-<name>.port，default 写 bh.port）',
  browser: '用户自己打开的浏览器（D11 附着模型：bh 永不 spawn）：chrome://inspect/#remote-debugging 开启后写 DevToolsActivePort，daemon 由此发现并 WS 直连（每条新连接弹一次 Allow）',
  session: 'Session（session.ts）：到 browser endpoint 的一条持久 WebSocket（flatten：全部 target session 共享一线）；activeSessionId 记活动 target，每次 cdp 调用自动注入 sessionId——这是路由的唯一机制',
  tab: 'type=page 的 CDP target（页签）。专属 tab 铁律：daemon 只落在自己的 tab（马标记 -> 空白孤儿 -> 后台新建）；操作用户 tab 必须显式授权（switch_tab/set_session）。操作面（helpers.ts）：switch_tab(target, activate=false) 附着不抢前台 / activate_tab 前台激活 / new_tab(url 默认 about:blank, background) / close_tab / list_tabs',
  placeholder: '_is_agent_startup_placeholder：about:blank 类启动占位页不算真 tab；ensure_real_tab 保证操作落在真页上',
  window: 'CDP windowId 存在但 helpers 层无窗口操作原语——窗口不是 bh 的一等对象；new_tab 落在当前窗口',
  navigation: 'goto_url = 地址栏输入的编程等价（Page.navigate + 等待判官 adjudicate_lost_navigation）',
};

/** Where a NEW task lands, per entry path — attach vs new tab. */
export const ATTACH_POLICY: Record<string, string> = {
  "bh '<js>'": 'attach：在活动 target 上执行（上一个 switch_tab/use 保持的；默认落点由专属 tab 铁律决定）',
  'app (plugins)': 'attach：ensure_app_tab 按 host 一 app 一 tab 复用，不存在才 new_tab（后台创建不抢焦点）',
  "bh --new-tab '<js>'": 'explicit：new_tab(about:blank) 后附着执行，tab 保持打开（新原语）',
  'attach 偏好': 'BH_ATTACH_URL_MATCH 环境变量优先（空串显式关），否则读实例注册表旁的 runtime/bh-<name>.attach 文件（D43：CLI/upgrade 重生的 daemon 不再丢应用的附着钉面）',
  'user tab': 'explicit 授权：调用方显式 switch_tab(targetId)/set_session 指定用户 tab 才可操作，daemon 永不自动选中用户正在看的页面',
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

  // attachable browser (DevToolsActivePort scan)
  const attachable = await browserAttachable();
  checks.push({ name: 'browser attachable', ok: attachable.ok, detail: attachable.detail });

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

  // rmux (informational; resident-app sessions are judged in the dashboard)
  const rmux = rmuxInfo();
  checks.push({ name: 'rmux', ok: true, detail: rmux.installed ? `${rmux.version ?? 'installed'} (${rmux.path})` : 'not installed (only needed for the x-intel monitor)' });

  // ffmpeg (informational — video export degrades to an HTML slideshow without it)
  let ffmpegDetail = 'not installed (video export degrades to HTML slideshow)';
  try {
    const { ffmpegPath } = await import('./video.js');
    const bin = ffmpegPath();
    if (bin) {
      const r = spawnSync(bin, ['-version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
      const ver = String(r.stdout ?? '').split('\n')[0]?.trim() ?? 'installed';
      ffmpegDetail = `${ver} (${bin})`;
    }
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
 * After the daemon is (re)born, fire-and-forget companions (dashboard, rmux,
 * page-detect watch, supervisor-core). Companions come up even when the
 * daemon is only HTTP-alive (waiting on Allow) — showing that state is the
 * dashboard's job. page-detect watch uses a named daemon and prompts a second
 * Chrome Allow on first use.
 */
export async function ensureDaemon(): Promise<void> {
  try {
    await ensureDaemonCore();
  } catch (e) {
    void ensureCompanions();
    throw e;
  }
  void ensureCompanions();
}

function companionStopped(name: string): boolean {
  try {
    const st = JSON.parse(readFileSync(path.join(dataDir(), `${name}.status.json`), 'utf8'));
    return st.state === 'stopped';
  } catch {
    return false;
  }
}

/**
 * The cadence page-detect watch persisted in its status file — guardians
 * (this spawn AND supervisor-core respawns) follow the user's last
 * `page-detect watch --interval S` instead of hardcoding a default.
 */
function companionInterval(name: string): number {
  try {
    const v = JSON.parse(readFileSync(path.join(dataDir(), `${name}.status.json`), 'utf8')).interval;
    if (typeof v === 'number' && v > 0) return v;
  } catch {
    /* absent — default below */
  }
  return 10;
}

function supervisorEntry(): string {
  const ws = path.join(workspaceDir(), 'apps', 'supervisor-core.mjs');
  if (existsSync(ws)) return ws;
  return path.join(path.dirname(DIST_DIR), 'assets', 'apps', 'supervisor-core.mjs');
}

async function ensureCompanions(): Promise<void> {
  // Companions are global singletons owned by the DEFAULT stack. Named daemons
  // (page-detect watch loop, x-intel) also pass through ensureDaemon — they
  // must not recursively re-spawn these companions.
  if (instanceName() !== DEFAULT_NAME) return;
  const wsApps = path.join(workspaceDir(), 'apps');
  const pdPath = path.join(wsApps, 'page-detect.mjs');
  const needProvision = !existsSync(pdPath)
    || !existsSync(path.join(wsApps, 'supervisor-core.mjs'))
    || !existsSync(path.join(wsApps, 'x-intel.mjs'))
    || existsSync(path.join(wsApps, 'x-core.mjs'))
    || existsSync(path.join(wsApps, 'x-core'))
    || (existsSync(pdPath) && !readFileSync(pdPath, 'utf8').includes("sub === 'watch'"));
  if (needProvision) {
    try {
      const { provisionWorkspace } = await import('./skills.js');
      provisionWorkspace(workspaceDir());
    } catch { /* spawn path below still tries */ }
  }
  let rmux: any;
  try {
    const { ensureDashboard } = await import('./dashboard.js');
    // Board comes UP by default but is NOT auto-opened as a browser tab — the
    // user decides when to visit 127.0.0.1:9870 (default: don't attach).
    await ensureDashboard();
  } catch { /* best-effort */ }
  try {
    const { Rmux } = await import('./rmux.js');
    rmux = new Rmux();
    if (rmux.version() && !(await rmux.daemonAlive())) rmux.startServer();
  } catch { /* best-effort */ }
  try {
    if (rmux && rmux.version()) {
      const pd = path.join(workspaceDir(), 'apps', 'page-detect.mjs');
      if (!existsSync(pd)) {
        process.stderr.write('bh: companion page-detect missing from workspace — run `bh skill sync`\n');
      } else if (!readFileSync(pd, 'utf8').includes("sub === 'watch'")) {
        process.stderr.write('bh: companion page-detect has no watch subcommand — run `bh skill sync`\n');
      } else if (!companionStopped('page-detect')) {
        await rmux.ensureSession('page-detect', {
          cwd: homeDir(),
          command: `"${process.execPath}" "${path.join(DIST_DIR, 'cli.js')}" --name page-detect page-detect watch --watch-loop --interval ${companionInterval('page-detect')}`,
          readyTimeout: 10,
        });
      }
      const supervisor = supervisorEntry();
      if (!existsSync(supervisor)) {
        process.stderr.write('bh: companion supervisor-core missing — run `bh skill sync`\n');
      } else {
        await rmux.ensureSession('supervisor-core', {
          cwd: homeDir(),
          command: `"${process.execPath}" "${supervisor}"`,
          readyTimeout: 10,
        });
      }
    }
  } catch { /* best-effort */ }
}

async function ensureDaemonCore(): Promise<void> {
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
      if (hh?.ok && hh.name === name) {
        // Listening is NOT ready: harness.connect() (attach + Allow prompt)
        // runs in the background after listen. Only CDP answering counts.
        try {
          await evalOn(port, 'return (await session.domains.Target.getTargets({})).targetInfos.length', 3000);
          return; // alive AND attached
        } catch { /* connect still in flight (e.g. waiting on the Allow click) */ }
      }
      const tail = logTail(name, 1).toLowerCase();
      if (tail.includes('permission-blocked')) {
        throw new Error(`permission-blocked: Chrome is showing the "Allow remote debugging?" prompt — ask the user to click Allow, then retry. Do not retry before they confirm.`);
      }
      if (tail.includes('eaddrinuse')) break; // another spawn won it; verify below
    }
    const hh = await health(port);
    if (hh?.ok && hh.name === name) {
      // HTTP-alive is NOT ready: the daemon lingers (by design) while the
      // browser is gone or its "Allow" prompt is pending. Only CDP counts.
      try {
        await evalOn(port, 'return (await session.domains.Target.getTargets({})).targetInfos.length', 3000);
        return;
      } catch {
        throw new Error(`daemon "${name}" answers on :${port} but is not attached yet (waiting on the "Allow remote debugging?" prompt, or the browser is closed) — it self-heals when the browser is reachable; see ${logFile(name)}`);
      }
    }
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
// (chrome-mode removed with the D11 spawn family: there is no bh-owned browser
// to flip headless — the attached browser belongs to the user.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// upgrade (D30): version-drift detection + planned rollout. Detection is
// automatic (every bh invocation); rolling is explicit (`bh upgrade`).
// ---------------------------------------------------------------------------

/** The version of THIS CLI/daemon build (package.json next to dist/). */
export function selfVersion(): string {
  return String(JSON.parse(readFileSync(path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'package.json'), 'utf8')).version);
}

export type DaemonDrift = { name: string; port: number; version: string | null };

/**
 * Alive daemons whose /health version or BUILD differs from ours. A missing
 * version field means pre-0.4.0 health output — the oldest still rolls; a
 * matching version with a DIFFERENT buildTime is a same-version hot-fix
 * reinstall (hit twice on 2026-09-08) and rolls too. Down daemons are not
 * drift (nothing to roll; they come up on demand with fresh code).
 */
export async function daemonVersionDrift(): Promise<DaemonDrift[]> {
  const self = selfVersion();
  const selfBuild = selfBuildTime();
  const found: DaemonDrift[] = [];
  await Promise.all(instanceNames().map(async (name) => {
    const rec = readInstanceRecord(name);
    if (!rec) return;
    const h = await health(rec.port, 600);
    if (!h?.ok) return;
    const staleVersion = (h.version ?? null) !== self;
    // Missing buildTime on a SAME-version daemon = the old build of this very
    // version (hot-fix reinstall) — that rolls too. Pre-0.4.0 daemons have no
    // version at all and are already caught by staleVersion.
    const staleBuild = !staleVersion && h.buildTime !== selfBuild;
    if (staleVersion || staleBuild) found.push({ name, port: rec.port, version: h.version ?? null });
  }));
  return found;
}

/** Our dist's mtime — the build stamp health reports as buildTime. */
export function selfBuildTime(): number {
  try { return statSync(path.join(DIST_DIR, 'cli.js')).mtimeMs; } catch { return 0; }
}

export type UpgradeState = {
  drift: DaemonDrift[];
  xIntelRunning: boolean;
  dashboardAlive: boolean;
  /** drifted named daemons other than default/x-intel (e.g. page-detect) */
  namedDaemons: string[];
  /** the on-demand x-search daemon is alive (a harvest ran recently; D47:
   *  stop it before the swap so a mid-harvest respawn can't race the install) */
  xSearchDaemonAlive?: boolean;
};

/**
 * Ordered rollout plan (pure, unit-tested): stacks stop top-down so nothing
 * re-pulls mid-swap, every drifted daemon is reborn (companions respawn only
 * ATTACHES to an alive named daemon — it never swaps code, so each named
 * daemon gets an explicit restart), the dashboard is swapped, and whatever
 * was running comes back.
 */
export function upgradePlan(s: UpgradeState): string[] {
  const steps: string[] = [];
  if (s.xIntelRunning) steps.push('x-intel stop（按序拆栈：先写 stopped 防 supervisor 重拉，再停 worker 与专属 daemon）');
  if (s.xSearchDaemonAlive) steps.push('x-search daemon 停（按需应用不重启：文件换新后下一次 harvest 自起）');
  steps.push('停 companions 会话（page-detect watch / supervisor-core；用户 stopped 状态尊重不拉）');
  steps.push('default daemon 重生（POST /quit + ensureDaemon；companions 幂等重拉到新版）');
  // x-search is the on-demand app: NEVER respawned by the generic loop (a
  // bare respawn contradicts 只停不启 and can fail the whole upgrade) — the
  // xSearchDaemonAlive stop-only branch owns it exclusively.
  for (const n of s.namedDaemons.filter(n => n !== 'x-search')) {
    steps.push(`${n} daemon 重生（companions 只附着已活 daemon 不换代码，须显式重启）`);
  }
  if (s.dashboardAlive) steps.push('dashboard stop + 起新（页面版本握手自动重载）');
  if (s.xIntelRunning) steps.push('x-intel start（worker 复活，收割继续）');
  steps.push('终验：全部 daemon health.version 对版、看板 200');
  return steps;
}
