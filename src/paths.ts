/**
 * BH_HOME path system: one root holding config/, runtime/, tmp/, the browser
 * workspace and the agent Chrome profile. Env override chain matches the
 * Python original (BH_HOME | BROWSER_HARNESS_HOME | XDG_CONFIG_HOME | default),
 * with a dev-checkout escape hatch so a source clone never pollutes the
 * installed stack's data.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_DIR = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/dist or <repo>/dist
const PKG_DIR = path.dirname(DIST_DIR);

export const DEFAULT_NAME = 'default';
export const DEFAULT_PORT = 9876;

/** True when running from a source checkout (tsconfig.json is npm-files-excluded). */
export function isDevCheckout(): boolean {
  return existsSync(path.join(PKG_DIR, 'tsconfig.json'));
}

/** Resolve BH_HOME. Dev checkouts get <repo>/.bh-dev unless explicitly pinned. */
export function homeDir(): string {
  const pinned = process.env.BH_HOME || process.env.BROWSER_HARNESS_HOME;
  if (pinned) return path.resolve(pinned);
  if (isDevCheckout()) return path.join(PKG_DIR, '.bh-dev');
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? path.join(xdg, 'browser-harness') : path.join(homedir(), '.config', 'browser-harness');
  return path.resolve(base);
}

function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function configDir(): string { return ensureDir(path.join(homeDir(), 'config')); }
export function runtimeDir(): string { return ensureDir(path.join(homeDir(), 'runtime')); }
export function tmpDir(): string { return ensureDir(path.join(homeDir(), 'tmp')); }

export function workspaceDir(): string {
  const pinned = process.env.BH_BROWSER_WORKSPACE || process.env.BH_AGENT_WORKSPACE; // latter = legacy alias
  if (pinned) return path.resolve(pinned);
  return ensureDir(path.join(homeDir(), 'browser-workspace'));
}

export function agentChromeProfileDir(): string {
  const pinned = process.env.BH_AGENT_CHROME_PROFILE;
  if (pinned) return path.resolve(pinned);
  return path.join(homeDir(), 'agent-chrome-profile');
}

export function taskProfilesDir(): string { return ensureDir(path.join(homeDir(), 'task-profiles')); }

/**
 * Load .env files with setdefault semantics — the real process environment
 * always wins. Order: <BH_HOME>/.env first, then <workspace>/.env (may set
 * additional keys; same key set twice keeps the first, like the original).
 */
export function loadEnvFiles(): void {
  for (const p of [path.join(homeDir(), '.env'), path.join(workspaceDir(), '.env')]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const eq = t.indexOf('=');
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      v = v.replace(/^["']|["']$/g, '');
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// BH_NAME multi-instance: port derivation + registry
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Current instance name from BH_NAME ('default' when unset). Throws on invalid names. */
export function instanceName(): string {
  const raw = process.env.BH_NAME;
  if (raw === undefined || raw === '') return DEFAULT_NAME;
  if (!NAME_RE.test(raw)) {
    throw new Error(`BH_NAME must match [A-Za-z0-9_-]{1,64}, got: ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** FNV-1a 32-bit hash. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Derived port for the current BH_NAME. Default instance keeps 9876 (back-compat). */
export function derivedPort(): number {
  const explicit = process.env.BH_PORT;
  if (explicit && Number.isFinite(Number(explicit))) return Number(explicit);
  const name = instanceName();
  if (name === DEFAULT_NAME) return DEFAULT_PORT;
  return 9877 + (fnv1a32(name) % 120);
}

/**
 * Instance registry: <runtime>/bh-<NAME>.port holding {port,pid,startedAt}.
 * The default instance writes bh.port (back-compat with the existing CLI log/port naming).
 */
function registryPath(name: string): string {
  return path.join(runtimeDir(), name === DEFAULT_NAME ? 'bh.port' : `bh-${name}.port`);
}

export type InstanceRecord = { port: number; pid: number; startedAt: number; dist?: string };

/** Atomically (tmp+rename) write this instance's record. */
export function writeInstanceRecord(name: string, port: number): void {
  const rec: InstanceRecord = { port, pid: process.pid, startedAt: Date.now(), dist: DIST_DIR };
  const p = registryPath(name);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), 'utf8');
  renameSync(tmp, p);
}

/** Read another/this instance's record, if present. */
export function readInstanceRecord(name: string): InstanceRecord | undefined {
  try {
    const raw = readFileSync(registryPath(name), 'utf8');
    const rec = JSON.parse(raw) as InstanceRecord;
    if (typeof rec.port === 'number' && typeof rec.pid === 'number') return rec;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Runtime file stems per instance: default keeps legacy bh.log naming. */
export function logFile(name: string): string {
  return path.join(tmpDir(), name === DEFAULT_NAME ? 'bh.log' : `bh-${name}.log`);
}
