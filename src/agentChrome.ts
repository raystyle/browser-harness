/**
 * Dedicated agent Chrome lifecycle: launch / stop / detect.
 *
 * This Chrome is ours — separate profile, pinned port, anti-throttle flags —
 * and is NEVER the user's daily browser. Stopping is event-adjudicated (the
 * debug port dying within 8s is the verdict, not a child-exit event), and
 * killing pids matches by user-data-dir or port only — never by process
 * name, which would take the user's own Chrome down with it.
 */

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Session } from './session.js';
import { acquireLock } from './locks.js';
import { agentChromeProfileDir } from './paths.js';
import { envTriBool } from './env.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// 9223 = installed stack; 9224 = WSL; 9225 = Windows dev (R006: WSL2 mirrored
// networking shares loopback with Windows, so stacks must pin different ports).
export function agentPort(): number {
  const raw = process.env.BH_AGENT_CDP_PORT;
  const v = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(v) && v > 0 ? v : 9223;
}

/** Anti-throttle flags — wait_for_render's setInterval heartbeat depends on them. */
const NO_THROTTLE_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion',
];

function headlessFlags(): string[] {
  const mode = envTriBool('BH_CHROME_HEADLESS');
  const headless = mode ?? (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  return headless ? ['--headless=new', '--disable-gpu'] : [];
}

function extraFlags(): string[] {
  const out: string[] = [];
  if (process.env.BH_CHROME_EXTRA_FLAGS) out.push(...process.env.BH_CHROME_EXTRA_FLAGS.split(/\s+/).filter(Boolean));
  if (envTriBool('BH_NO_THROTTLE')) out.push(...NO_THROTTLE_FLAGS);
  return out;
}

/**
 * Chrome binary discovery. Windows scans the registry (StartMenuInternet +
 * App Paths) — every browser Windows knows about, wherever it is installed —
 * then picks by CDP preference order (Dev > Beta/Canary > Chrome > Chromium >
 * Brave > Edge). Hardcoded path lists kept missing non-standard installs, and
 * the old --version liveness probe is meaningless on Windows: Chromium never
 * prints it there, a running instance hangs the probe (ETIMEDOUT), and Edge's
 * "opened in existing session" banner once passed it as liveness (M006).
 * Explicit BH_CHROME_PATH / CHROME_PATH always wins.
 */
export function chromeBinary(): string | null {
  const pinned = process.env.BH_CHROME_PATH || process.env.CHROME_PATH;
  if (pinned && existsSync(pinned)) return pinned;
  if (process.platform === 'win32') return winChromeBinary();
  const candidates: string[] = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    // Probe liveness: a shipped stub must not be picked as "the" binary.
    try {
      const r = spawnSync(c, ['--version'], { timeout: 5000, windowsHide: true });
      if (r.status === 0 || (r.stdout && String(r.stdout).trim().length > 0)) return c;
    } catch { /* try next */ }
  }
  // PATH fallback.
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chrome', 'microsoft-edge']) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 5000, windowsHide: true });
      if (r.status === 0 || (r.stdout && String(r.stdout).trim().length > 0)) return c;
    } catch { /* try next */ }
  }
  return null;
}

/** CDP preference order — non-Chromium browsers (Firefox…) are skipped: no CDP. */
const WIN_BROWSER_PREFS: Array<[RegExp, number]> = [
  [/chrome\s*dev/i, 100],
  [/chrome\s*(beta|canary)/i, 90],
  [/chrome/i, 80],
  [/chromium/i, 70],
  [/brave/i, 60],
  [/edge|msedge/i, 50],
];

interface DiscoveredBrowser { name: string; bin: string; }

/** Extract the exe path from a registry shell\open\command value like `"C:\...\chrome.exe" --flag %1`. */
function exeFromCmd(cmd: string): string | null {
  const quoted = /^"([^"]+)"/.exec(cmd.trim())?.[1];
  if (quoted) return quoted;
  const first = cmd.trim().split(/\s+/)[0] ?? '';
  return first.toLowerCase().endsWith('.exe') ? first : null;
}

/** Registry scan: where Windows says its browsers live. Empty on any failure. */
function discoverWinBrowsers(): DiscoveredBrowser[] {
  const script = [
    '$out = @()',
    `$roots = @('HKLM:\\SOFTWARE\\Clients\\StartMenuInternet', 'HKCU:\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM:\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet')`,
    'foreach ($r in $roots) {',
    '  Get-ChildItem $r -ErrorAction SilentlyContinue | ForEach-Object {',
    '    $cmd = (Get-ItemProperty "$($_.PSPath)\\shell\\open\\command" -ErrorAction SilentlyContinue)."(default)"',
    '    if ($cmd) { $out += [pscustomobject]@{ name = $_.PSChildName; cmd = $cmd } }',
    '  }',
    '}',
    `$names = 'chrome.exe','msedge.exe','brave.exe','chromium.exe','chromium-browser.exe'`,
    'foreach ($n in $names) {',
    '  $p = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$n" -ErrorAction SilentlyContinue)."(default)"',
    '  if ($p) { $out += [pscustomobject]@{ name = "AppPaths:$n"; cmd = $p } }',
    '}',
    '$out | ConvertTo-Json -Compress',
  ].join('\n');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script],
      { timeout: 15_000, windowsHide: true, encoding: 'utf8' });
    const raw = String(r.stdout ?? '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<{ name?: string; cmd?: string }> | { name?: string; cmd?: string };
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const out: DiscoveredBrowser[] = [];
    for (const row of rows) {
      const bin = row.cmd ? exeFromCmd(row.cmd) : null;
      if (bin && !out.some(d => d.bin.toLowerCase() === bin.toLowerCase())) out.push({ name: row.name ?? '', bin });
    }
    return out;
  } catch { return []; }
}

function winChromeBinary(): string | null {
  const scored: Array<{ bin: string; score: number }> = [];
  for (const b of discoverWinBrowsers()) {
    const pref = WIN_BROWSER_PREFS.find(([re]) => re.test(`${b.name} ${b.bin}`));
    if (!pref) continue; // not a known CDP-capable browser
    if (!existsSync(b.bin)) continue;
    scored.push({ bin: b.bin, score: pref[1] });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.bin ?? null;
}

/**
 * Read <profile>/DevToolsActivePort → ws://127.0.0.1:<port><path>. Returns
 * undefined when the file is missing/malformed (browser not up yet).
 */
export function readDevToolsActivePort(profileDir?: string): { wsUrl: string; port: number } | undefined {
  const p = path.join(profileDir ?? agentChromeProfileDir(), 'DevToolsActivePort');
  try {
    const [portStr, wsPath] = readFileSync(p, 'utf8').trim().split('\n');
    const port = Number(portStr);
    if (!Number.isFinite(port) || !wsPath || !wsPath.startsWith('/devtools/')) return undefined;
    return { wsUrl: `ws://127.0.0.1:${port}${wsPath}`, port };
  } catch {
    return undefined;
  }
}

/**
 * Resolve the browser WS URL. DevToolsActivePort first (the only reliable
 * source for the chrome://inspect toggle flow — those serve no /json), then
 * /json/version's webSocketDebuggerUrl (Chrome 154+ Dev no longer writes the
 * file for plain --remote-debugging-port launches).
 */
export async function readWsUrl(profileDir?: string): Promise<{ wsUrl: string; port: number } | undefined> {
  const fromFile = readDevToolsActivePort(profileDir);
  if (fromFile) return fromFile;
  try {
    const res = await fetch(`http://127.0.0.1:${agentPort()}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return undefined;
    const j = await res.json() as { webSocketDebuggerUrl?: string };
    if (j.webSocketDebuggerUrl?.startsWith('ws://')) return { wsUrl: j.webSocketDebuggerUrl, port: agentPort() };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Is the debug port serving /json/version? */
export async function debugPortAlive(port = agentPort()): Promise<{ alive: boolean; ua?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return { alive: false };
    const j = await res.json() as { 'User-Agent'?: string };
    return { alive: true, ua: j['User-Agent'] };
  } catch {
    return { alive: false };
  }
}

export async function isAgentChromeRunning(): Promise<boolean> {
  const port = await debugPortAlive();
  if (!port.alive) return false;
  return ownsDebugPort(port.ua);
}

/**
 * Ownership verdict (nu_plugin_browse's .session pattern): "the port is alive"
 * and "the browser is ours" are different claims. The profile's bh-agent.json
 * records which binary we launched; a live port counts as ours only when that
 * record still matches what we would launch now AND the serving browser's UA
 * family agrees. No record = legacy/manual launch, trust the port.
 */
function ownsDebugPort(ua?: string): boolean {
  let recorded: string | undefined;
  try {
    recorded = (JSON.parse(readFileSync(path.join(agentChromeProfileDir(), 'bh-agent.json'), 'utf8')) as { bin?: string }).bin;
  } catch { /* no ownership record — trust the port */ }
  if (!recorded) return true;
  const current = chromeBinary();
  if (current && current.toLowerCase() !== recorded.toLowerCase()) return false; // we'd launch something else now
  if (!ua) return true;
  const familyIsEdge = (s: string) => /msedge/i.test(s);
  return familyIsEdge(recorded) === ua.includes('Edg/');
}

/** Headless state as reported by the browser itself (chrome-mode verification). */
export async function agentChromeHeadless(): Promise<boolean | undefined> {
  const r = await debugPortAlive();
  if (!r.alive || !r.ua) return undefined;
  return r.ua.includes('HeadlessChrome');
}

/**
 * Normalize the profile's exit_type so Chrome never shows the
 * "Chrome didn't shut down correctly" bubble. On Windows every kill is
 * TerminateProcess, so Chrome can never write a clean exit_type itself —
 * run this after each stop and before each launch.
 */
function normalizeExitType(): void {
  const prefs = path.join(agentChromeProfileDir(), 'Default', 'Preferences');
  try {
    const raw = readFileSync(prefs, 'utf8');
    const j = JSON.parse(raw) as { profile?: { exit_type?: string; exited_cleanly?: boolean } };
    if (j.profile?.exit_type === 'Normal' && j.profile?.exited_cleanly !== false) return;
    j.profile ??= {};
    j.profile.exit_type = 'Normal';
    j.profile.exited_cleanly = true;
    writeFileSync(prefs, JSON.stringify(j));
  } catch { /* absent/malformed profile → fresh profile behaviour */ }
}

/**
 * One-time adoption of the OLD Python browser-harness's agent Chrome profile
 * (logins/cookies ride in the profile). Skipped when our profile already
 * exists; caches/service-workers are not copied; stale endpoint files removed.
 */
function adoptLegacyProfile(): void {
  const ours = agentChromeProfileDir();
  if (existsSync(ours)) return;
  const legacy = path.join(homedir(), '.config', 'browser-harness', 'agent-chrome-profile');
  if (!existsSync(legacy)) return;
  try {
    cpSync(legacy, ours, {
      recursive: true, dereference: true, force: true,
      filter: (s: string) => !/Cache|Service Worker|blob_storage|Crashpad|^Singleton|^DevToolsActivePort/.test(path.basename(s)),
    });
    for (const junk of ['DevToolsActivePort', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { rmSync(path.join(ours, junk), { force: true }); } catch { /* absent */ }
    }
  } catch { /* partial adoption degrades to a fresh profile */ }
}

/**
 * Idempotent launch. Returns true when the debug port answers. Concurrent
 * callers serialize on the agent-chrome-<port> lock (losers out-wait 30s and
 * piggyback on the winner).
 */
export async function launchAgentChrome(): Promise<boolean> {
  if (await isAgentChromeRunning()) return true;
  const bin = chromeBinary();
  if (!bin) {
    throw new Error('no Chrome/Chromium binary found — set BH_CHROME_PATH or install Chrome');
  }
  // stealAfterMs: Infinity — only a dead holder may be robbed. A 30s time-steal
  // let a second process rob a slow live launch and double-spawn onto the port.
  const lock = acquireLock(`agent-chrome-${agentPort()}`, { stealAfterMs: Infinity, meta: { bin } });
  if (!lock) {
    // Someone else is launching; out-wait up to 30s then piggyback.
    for (let i = 0; i < 150; i++) {
      await sleep(200);
      if (await isAgentChromeRunning()) return true;
    }
    return false;
  }
  try {
    if (await isAgentChromeRunning()) return true; // double-check inside the lock
    adoptLegacyProfile();
    normalizeExitType();
    // Flags are NOT quoted — quoting once leaked the launch into the user's default profile (M101).
    const args = [
      `--user-data-dir=${agentChromeProfileDir()}`,
      `--remote-debugging-port=${agentPort()}`,
      '--hide-crash-restore-bubble',
      ...NO_THROTTLE_FLAGS,
      ...headlessFlags(),
      ...extraFlags(),
      'about:blank',
    ];
    const child = spawn(bin, args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    const up = await (async () => {
      for (let i = 0; i < 100; i++) {
        await sleep(200);
        if (await isAgentChromeRunning()) return true;
        if (child.exitCode !== null) break;
      }
      return await isAgentChromeRunning();
    })();
    if (up) {
      // Ownership record, written inside the lock: the profile dir states which
      // binary owns the debug port (read back by ownsDebugPort).
      try {
        writeFileSync(path.join(agentChromeProfileDir(), 'bh-agent.json'),
          JSON.stringify({ bin, port: agentPort(), pid: child.pid, startedAt: Date.now() }, null, 2) + '\n');
      } catch { /* best-effort ownership record */ }
    }
    return up;
  } finally {
    lock.release();
  }
}

/** Pids whose command line references our profile dir or debug port — never by process name. */
function agentChromePids(): number[] {
  const marker = agentChromeProfileDir();
  try {
    if (process.platform === 'win32') {
      // No Name filter: whatever browser chromeBinary() picked must be stoppable
      // (a Name='chrome.exe' filter once left a fallback msedge unkillable, M006).
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`],
        { timeout: 15_000, windowsHide: true, encoding: 'utf8' });
      return String(r.stdout ?? '').split(/\s+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
    }
    const r = spawnSync('ps', ['-eo', 'pid=,command='], { timeout: 15_000, encoding: 'utf8' });
    const out: number[] = [];
    for (const line of String(r.stdout ?? '').split('\n')) {
      if (line.includes(marker) || line.includes(`--remote-debugging-port=${agentPort()}`)) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) out.push(pid);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** True when the debug port stops answering within 8s (event verdict, not a timeout guess). */
async function debugPortDiesWithin8s(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (!(await debugPortAlive()).alive) return true;
  }
  return false;
}

/**
 * Stop the agent Chrome. Graceful first (Browser.close over a short-lived
 * Session); verdict = port dead in 8s. Fallback: pids matched by
 * user-data-dir → SIGTERM → 10s → force. exit_type normalized after.
 */
export async function stopAgentChrome(): Promise<boolean> {
  if (!(await isAgentChromeRunning())) {
    normalizeExitType();
    return true;
  }
  // 1. Graceful: Browser.close (closing the pipe cancels in-flight tasks — swallow everything).
  try {
    const ws = await readWsUrl();
    if (ws) {
      const s = new Session();
      await s.connect({ wsUrl: ws.wsUrl, timeoutMs: 3000 });
      try { await s.domains.Browser.close(); } catch { /* already going down */ }
      s.close();
    }
  } catch { /* fall through to pids */ }
  if (await debugPortDiesWithin8s()) {
    normalizeExitType();
    return true;
  }
  // 2. Targeted kill — by user-data-dir only. os.kill on Windows = TerminateProcess.
  const pids = agentChromePids();
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* raced away */ }
  }
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (!(await debugPortAlive()).alive) {
      normalizeExitType();
      return true;
    }
  }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* raced away */ }
  }
  await sleep(1000);
  if ((await debugPortAlive()).alive) {
    // 3. Port-table kill (nu_plugin_browse's force_kill_port): marker matching
    // missed the owner; the kernel's port table doesn't lie.
    portTableKill(agentPort());
    await sleep(1000);
  }
  normalizeExitType();
  return !(await debugPortAlive()).alive;
}

/** Kill whatever the OS port table says is LISTENING on the port. Last resort. */
function portTableKill(port: number): void {
  const pids = new Set<number>();
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('cmd', ['/C', `netstat -ano | findstr :${port} | findstr LISTENING`],
        { timeout: 15_000, windowsHide: true, encoding: 'utf8' });
      for (const tok of String(r.stdout ?? '').split(/\s+/)) {
        const n = Number(tok);
        if (Number.isInteger(n) && n > 0 && n !== process.pid) pids.add(n);
      }
    } else {
      const r = spawnSync('lsof', ['-t', '-i', `:${port}`], { timeout: 15_000, encoding: 'utf8' });
      for (const line of String(r.stdout ?? '').split('\n')) {
        const n = Number(line.trim());
        if (Number.isInteger(n) && n > 0 && n !== process.pid) pids.add(n);
      }
    }
  } catch { /* best effort */ }
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* raced away */ }
  }
}

/** Endpoint the daemon should pin: BU_CDP_URL semantics (kept as BH_CDP_URL in the TS line). */
export function agentCdpUrl(): string {
  return `http://127.0.0.1:${agentPort()}`;
}
