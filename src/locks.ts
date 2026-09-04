/**
 * Single-instance lock primitive: exclusive-create file + pid liveness +
 * staleness steal. Node has no flock; O_EXCL creation (`openSync 'wx'`) is
 * atomic on both Windows and POSIX, and a dead holder's file is stolen on the
 * next acquire — so a crash never leaves a deadlock behind.
 *
 * For port reservation the caller intentionally NEVER calls release(): the
 * lock file must outlive the process until the next acquirer steals it
 * (bind-probe-then-close is a TOCTOU that would let two concurrent tasks
 * attach the same Chrome and silently break isolation).
 */

import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runtimeDir } from './paths.js';

export type LockHandle = { release(): void };

function lockPath(name: string): string {
  return path.join(runtimeDir(), `${name}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = exists but owned by another user; ESRCH = gone.
    return e?.code === 'EPERM';
  }
}

/**
 * Acquire the named lock. Returns a handle, or null when a live process
 * holds it. A holder recorded as dead (or older than stealAfterMs) is
 * unlinked and retried once. Pass stealAfterMs: Infinity to steal ONLY from
 * dead holders — a time-based steal of a live holder is how two processes
 * end up spawning against the same resource (a slow first launch must never
 * be robbed mid-flight; only kernel-level locks can expiry-steal safely).
 */
export function acquireLock(name: string, opts: { stealAfterMs?: number; meta?: Record<string, unknown> } = {}): LockHandle | null {
  const p = lockPath(name);
  const stealAfterMs = opts.stealAfterMs ?? 30_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(p, 'wx');
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      // Held — read the holder; steal only if dead or stale.
      let holder: LockRecord = {};
      try {
        holder = JSON.parse(readFileSync(p, 'utf8')) as LockRecord;
      } catch { /* unreadable → treat as dead */ }
      const pid = typeof holder.pid === 'number' ? holder.pid : 0;
      const startedAt = typeof holder.startedAt === 'number' ? holder.startedAt : 0;
      const dead = pid === 0 || !pidAlive(pid);
      const stale = Number.isFinite(stealAfterMs) && Date.now() - startedAt > stealAfterMs;
      if (!(dead || stale)) return null;
      try { rmSync(p, { force: true }); } catch { /* raced away */ }
      continue;
    }
    // Lock byte written AFTER creation so competing readers never see a blank.
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), meta: opts.meta ?? {} }) + '\n');
    } finally {
      closeSync(fd); // the file's existence is the lock; fd not needed
    }
    // Re-verify we still own it (a steal may have raced our create).
    if (!existsSync(p)) continue;
    return {
      release() {
        try { rmSync(p, { force: true }); } catch { /* already gone */ }
      },
    };
  }
  return null;
}

export interface LockRecord { pid?: number; startedAt?: number; meta?: Record<string, unknown> }

/** Read a lock file's record (holder pid + metadata), or null when absent/unreadable. */
export function readLock(name: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(lockPath(name), 'utf8')) as LockRecord;
  } catch { return null; }
}
