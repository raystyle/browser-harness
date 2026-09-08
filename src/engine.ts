/**
 * Self-started headless Chrome ENGINE (D37) — the tool-grade browser.
 *
 * Distinct from the D11 attach model (the USER's browser is never spawned):
 * an engine is an ephemeral worker process — its own temp user-data-dir,
 * port 0, killed on stop. Lifecycle rules: temp profile only, always kill on
 * exit, never touch a user profile. Proven by the 2026-09-08 PoC: the full
 * D11 discipline (marker tab etc.) and D35 refs work unchanged on it.
 */

import { spawn, spawnSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { homeDir, runtimeDir } from './paths.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type EngineHandle = {
  pid: number;
  port: number;
  wsUrl: string;
  userDataDir: string;
  startedAt: string;
};

/** Locate a Chrome-family executable (registry first on Windows, M006 method). */
export function findChromeBinary(): string | null {
  if (process.platform === 'win32') {
    try {
      // EncodedCommand sidesteps the quote-escaping swamp entirely.
      const ps = `$k='HKLM:\\SOFTWARE\\Clients\\StartMenuInternet'; foreach($s in 'Google Chrome','Google Chrome Dev','Google Chrome Beta','Google Chrome SxS'){$p=(Get-ItemProperty -Path ($k+'\\'+$s+'\\shell\\open\\command') -ErrorAction SilentlyContinue).'(default)'; if($p){ $p.Trim('"'); break }}`;
      const enc = Buffer.from(ps, 'utf16le').toString('base64');
      const out = execSync(`powershell -NoProfile -EncodedCommand ${enc}`,
        { encoding: 'utf8', timeout: 8000, windowsHide: true });
      // CLIXML progress records can ride along on stdout — keep the exe line.
      const exeLine = out.split(/\r?\n/).map(l => l.trim()).find(l => /\.exe$/i.test(l));
      if (exeLine) return exeLine;
    } catch { /* registry miss */ }
    const pf = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    for (const p of [
      path.join(pf, 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]) if (existsSync(p)) return p;
    return null;
  }
  if (process.platform === 'darwin') {
    for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
      if (existsSync(p)) return p;
    }
    return null;
  }
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [b], { encoding: 'utf8', timeout: 4000 });
    if (r.status === 0 && String(r.stdout ?? '').trim()) return String(r.stdout).trim();
  }
  return null;
}

function handleFile(): string {
  return path.join(runtimeDir(), 'engine.json');
}

export function readEngineHandle(): EngineHandle | null {
  try {
    return JSON.parse(readFileSync(handleFile(), 'utf8')) as EngineHandle;
  } catch { return null; }
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Is the recorded engine actually serving CDP right now? */
export async function engineStatus(): Promise<EngineHandle & { alive: boolean; cdp: boolean }> {
  const h = readEngineHandle();
  if (!h) return { pid: 0, port: 0, wsUrl: '', userDataDir: '', startedAt: '', alive: false, cdp: false };
  const alive = pidAlive(h.pid);
  let cdp = false;
  if (alive) {
    try {
      const r = await fetch(`http://127.0.0.1:${h.port}/json/version`, { signal: AbortSignal.timeout(1500) });
      cdp = r.ok;
    } catch { /* headless=new serves /json/version; older may not */ }
  }
  return { ...h, alive, cdp };
}

/** Remove a dead engine's leftovers (stale handle + orphan temp dir). */
async function reapDeadEngine(h: EngineHandle | null): Promise<void> {
  if (h && h.userDataDir && existsSync(h.userDataDir)) {
    try { rmSync(h.userDataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (h) { try { rmSync(handleFile(), { force: true }); } catch { /* ok */ } }
}

/**
 * Ensure exactly ONE engine runs. Live one is reused; a dead handle is
 * reaped first (temp dir + handle), then a fresh engine spawns.
 */
export async function ensureEngine(): Promise<EngineHandle> {
  const st = await engineStatus();
  if (st.alive && st.cdp) return readEngineHandle() as EngineHandle;
  await reapDeadEngine(readEngineHandle());

  const bin = findChromeBinary();
  if (!bin) throw new Error('bh: no Chrome-family binary found for the engine（注册表与常见路径均未命中）');
  const userDataDir = path.join(homeDir(), 'tmp', `engine-${Date.now()}`);
  mkdirSync(userDataDir, { recursive: true });
  const child = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  // The port lands in DevToolsActivePort once the engine is up.
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (existsSync(portFile)) {
      try {
        const [portLine, pathLine] = readFileSync(portFile, 'utf8').trim().split('\n');
        const port = Number(portLine);
        if (Number.isInteger(port) && port > 0) {
          const handle: EngineHandle = {
            pid: child.pid ?? 0, port, wsUrl: `ws://127.0.0.1:${port}${pathLine ?? ''}`,
            userDataDir, startedAt: new Date().toISOString(),
          };
          mkdirSync(runtimeDir(), { recursive: true });
          writeFileSync(handleFile(), JSON.stringify(handle), 'utf8');
          return handle;
        }
      } catch { /* file mid-write; retry */ }
    }
    if (!pidAlive(child.pid ?? 0)) break;
  }
  await reapDeadEngine({ pid: child.pid ?? 0, port: 0, wsUrl: '', userDataDir, startedAt: '' });
  throw new Error('bh: engine did not come up within 10s（DevToolsActivePort 未出现）');
}

/** Kill the engine process tree + remove its temp dir + drop the handle. */
export async function stopEngine(): Promise<{ stopped: boolean; note: string }> {
  const h = readEngineHandle();
  if (!h) return { stopped: false, note: 'no engine on record' };
  if (pidAlive(h.pid)) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(h.pid)], { windowsHide: true });
      else { try { process.kill(-h.pid, 'SIGTERM'); } catch { process.kill(h.pid, 'SIGTERM'); } }
    } catch { /* raced away */ }
  }
  await sleep(400);
  await reapDeadEngine(h);
  return { stopped: true, note: `engine pid ${h.pid} killed, temp dir removed` };
}
