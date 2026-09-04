/**
 * Task-level browser isolation (--once / --batch): a dedicated stack per task
 * — task-<hex8> instance name, a CLONED login profile, a kernel-reserved port
 * in 9230–9260 — torn down when the process exits. The port lock is held to
 * process death (never released): bind-probe-then-close is a TOCTOU that would
 * let two concurrent tasks attach the same Chrome and silently break isolation.
 */

import { cpSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { acquireLock, type LockHandle } from './locks.js';
import { agentChromeProfileDir, taskProfilesDir } from './paths.js';
import { envSetDefault } from './env.js';

const PORT_RANGE = Array.from({ length: 31 }, (_, i) => 9230 + i); // 9230–9260

const IGNORE = (src: string) => /Cache|Service Worker|blob_storage|Crashpad|^Singleton/.test(path.basename(src));

/** Clone the base login profile; a partial clone degrades to fresh-profile behaviour. */
function cloneProfile(dst: string): void {
  const src = agentChromeProfileDir();
  if (!existsSync(src)) return; // no base → fresh profile
  try {
    cpSync(src, dst, { recursive: true, dereference: true, force: true, filter: (s: string) => !IGNORE(s) });
  } catch {
    try { mkdirSync(dst, { recursive: true }); } catch { /* partial clone acceptable */ }
  }
  try { unlinkSync(path.join(dst, 'DevToolsActivePort')); } catch { /* absent */ } // stale file points at a dead port
}

function canBind(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

type Reserved = { port: number; lock: LockHandle };
let reserved: Reserved | null = null;

/** Reserve a task port; null when the range is full (fall back to the shared stack, don't fail). */
async function reservePort(): Promise<Reserved | null> {
  for (const port of PORT_RANGE) {
    // stealAfterMs: Infinity — the lock file intentionally outlives the process
    // (never released); only a dead holder's port may be re-claimed. A live
    // task's port must never be time-stolen into a second task.
    const lock = acquireLock(`task-port-${port}`, { stealAfterMs: Infinity });
    if (!lock) continue; // another task holds it
    if (!(await canBind(port))) { // non-task listener occupies it
      try { lock.release(); } catch { /* raced */ }
      continue;
    }
    return { port, lock }; // lock intentionally NEVER released — process death frees it
  }
  return null;
}

export type TaskStack = {
  name: string;
  port: number | null;
  profile: string;
  teardown(): Promise<void>;
};

/**
 * Apply isolation from argv BEFORE anything binds env: pin the envs so the
 * daemon (and agent Chrome launcher) target this task's stack only.
 * Already-pinned stacks (BH_NAME/BH_CDP_URL/BH_CDP_WS set) are left alone.
 */
export async function applyFromArgv(argv: string[]): Promise<TaskStack | null> {
  if (argv[0] !== '--once' && argv[0] !== '--batch') return null;
  if (argv.includes('--shared')) return null;
  if (process.env.BH_NAME || process.env.BH_CDP_URL || process.env.BH_CDP_WS) return null;

  const name = `task-${Math.random().toString(16).slice(2, 10)}`;
  const profile = path.join(taskProfilesDir(), name);
  cloneProfile(profile);
  process.env.BH_NAME = name;
  reserved = await reservePort();
  if (reserved) {
    process.env.BH_AGENT_CDP_PORT = String(reserved.port);
    process.env.BH_AGENT_CHROME_PROFILE = profile;
    process.env.BH_CDP_URL = `http://127.0.0.1:${reserved.port}`; // pinned: the daemon NEVER reaches the user's Chrome
  }
  process.env.BH_ISOLATED_TASK = '1';
  envSetDefault('BH_IPC_TIMEOUT', '10'); // cold clone + first start; user's explicit value wins

  return {
    name,
    port: reserved?.port ?? null,
    profile,
    async teardown(): Promise<void> {
      // Profile cleanup only — Chrome/daemon teardown belongs to the caller's
      // finally (Chrome BEFORE daemon). Guarded rmtree: never outside task-profiles.
      try {
        if (profile.startsWith(taskProfilesDir())) rmSync(profile, { recursive: true, force: true });
      } catch { /* teardown is best-effort */ }
    },
  };
}
