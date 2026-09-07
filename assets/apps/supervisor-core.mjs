/**
 * supervisor-core — generic guardian for resident apps (page-detect, x-intel,
 * …). Register each in SUPERVISED. Do not supervise this process itself.
 * Every beat: session gone → spawn; heartbeat past timeout → kill+spawn.
 * A missing heartbeat is not stale while the session is alive (cold start)
 * or within SPAWN_GRACE of a restart we issued.
 * `data/<name>.status.json` state `stopped` is honored.
 * onDemand apps (x-intel) are not spawned until the user starts them
 * (status running/degraded, or the session is already alive).
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const description = '统一守护常驻应用，会话/心跳异常自动重启。';
export const resident = true;

const bhHome = () => process.env.BH_HOME
  ?? process.env.BROWSER_HARNESS_HOME
  ?? (process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'browser-harness')
    : path.join(homedir(), '.config', 'browser-harness'));
const dataDir = () => process.env.BH_DATA_DIR ?? path.join(bhHome(), 'data');

const CHECK_INTERVAL = Number(process.env.SUPERVISOR_CHECK_INTERVAL ?? 15);
const SPAWN_GRACE = Number(process.env.SUPERVISOR_SPAWN_GRACE ?? 30);
const STATUS_FILE = () => path.join(dataDir(), 'supervisor-core.status.json');
const LOG_FILE = () => path.join(dataDir(), 'supervisor-core.log');

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));
const hms = () => new Date().toTimeString().slice(0, 8);

function logLine(text) {
  const line = `[${hms()}] supervisor-core ${text}`;
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(LOG_FILE(), line + '\n');
  } catch { /* best-effort */ }
  console.log(line);
}

function writeStatus(st) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(STATUS_FILE(), JSON.stringify({ _v: '1.0.0', ts: new Date().toISOString(), ...st }));
  } catch { /* best-effort */ }
}

function heartbeatAge(file) {
  try {
    return (Date.now() - statSync(path.join(dataDir(), file)).mtimeMs) / 1000;
  } catch {
    return null;
  }
}

/** G002 status `state` for a supervised app; null if the file is absent. */
function appStatusState(name) {
  try {
    return JSON.parse(readFileSync(path.join(dataDir(), `${name}.status.json`), 'utf8')).state ?? null;
  } catch {
    return null;
  }
}

function distDir() {
  if (process.env.BH_DIST) return process.env.BH_DIST;
  try {
    return path.join(readFileSync(path.join(bhHome(), 'runtime', 'dist.path'), 'utf8').trim(), 'dist');
  } catch { /* no stamp */ }
  return null;
}

/**
 * The cadence page-detect watch persisted in its status file — a respawn
 * follows the user's last `page-detect watch --interval S` instead of
 * resetting to a hardcoded default.
 */
function pageDetectInterval() {
  try {
    const v = JSON.parse(readFileSync(path.join(dataDir(), 'page-detect.status.json'), 'utf8')).interval;
    if (typeof v === 'number' && v > 0) return v;
  } catch { /* absent */ }
  return 10;
}

function workspaceDir() {
  return process.env.BH_BROWSER_WORKSPACE
    ?? path.join(bhHome(), 'browser-workspace');
}

function cliJs() {
  const d = distDir();
  if (!d) throw new Error('no cli.js path');
  return path.join(d, 'cli.js');
}

function appEntry(name) {
  return path.join(workspaceDir(), 'apps', `${name}.mjs`);
}

async function importDist(module) {
  const d = distDir();
  if (!d) throw new Error('no dist path found — run bh --start or bh skill sync first');
  return await import(`${pathToFileURL(path.join(d, module)).href}`);
}

/**
 * Unified supervision registry for resident apps (not this guardian itself).
 * Add a row when a new resident app needs healing. Timeouts are seconds.
 */
const SUPERVISED = [
  {
    name: 'page-detect',
    session: 'page-detect',
    heartbeat: 'page-watch.json',
    timeout: 60,
    command: () => `"${process.execPath}" "${cliJs()}" --name page-detect page-detect watch --watch-loop --interval ${pageDetectInterval()}`,
  },
  {
    name: 'x-intel',
    session: 'x-monitor',
    heartbeat: 'x_worker.heartbeat',
    timeout: 120,
    onDemand: true,
    command: () => `"${process.execPath}" "${appEntry('x-intel')}" worker`,
  },
];

export async function main(argv = [], ctx) {
  if (argv.includes('--once')) return once();

  const { Rmux } = await importDist('rmux.js');
  const rmux = new Rmux();
  const state = Object.fromEntries(SUPERVISED.map(e => [e.name, '未知']));
  const lastSpawn = new Map();

  logLine(`启动（每 ${CHECK_INTERVAL}s 检查 ${SUPERVISED.length} 个常驻应用）`);
  for (;;) {
    const actions = [];
    try {
      for (const e of SUPERVISED) {
        const st = appStatusState(e.name);
        if (st === 'stopped') {
          state[e.name] = '已停止';
          continue;
        }
        const alive = await rmux.hasSession(e.session).catch(() => false);
        if (e.onDemand && st !== 'running' && st !== 'degraded' && !alive) {
          state[e.name] = '未运行';
          continue;
        }
        const age = heartbeatAge(e.heartbeat);
        const spawnedAt = lastSpawn.get(e.name) ?? 0;
        const inGrace = spawnedAt > 0 && (Date.now() - spawnedAt) < SPAWN_GRACE * 1000;
        const sessionDead = !alive;
        const heartbeatStale = alive && age !== null && age > e.timeout;
        const hungWithoutBeat = alive && age === null && spawnedAt > 0 && !inGrace
          && (Date.now() - spawnedAt) > e.timeout * 1000;
        if (sessionDead || heartbeatStale || hungWithoutBeat) {
          state[e.name] = '重启中';
          actions.push(e.name);
          if (alive) await rmux.killSession(e.session).catch(() => {});
          await sleep(1);
          await rmux.ensureSession(e.session, { command: e.command(), readyTimeout: 15 }).catch(() => {});
          lastSpawn.set(e.name, Date.now());
          state[e.name] = '已重启';
          logLine(`重启 ${e.name}（session:${alive ? '失' : '缺'}, heartbeat:${age === null ? '缺' : Math.round(age) + 's'}）`);
        } else {
          state[e.name] = '正常';
        }
      }
    } catch (err) {
      logLine(`巡检异常：${err?.message ?? err}`);
    }

    const metrics = [
      { label: '守护进程', value: `${SUPERVISED.length} 应用` },
      ...SUPERVISED.map(e => ({ label: e.name, value: state[e.name] })),
    ];
    writeStatus({
      state: 'running',
      metrics,
      event: actions.length ? { ts: new Date().toISOString(), text: `重启 ${actions.join('、')}` } : undefined,
    });
    await sleep(CHECK_INTERVAL);
  }
}

/** One-shot supervision beat — useful for tests and `bh supervisor-core --once`. */
async function once() {
  const { Rmux } = await importDist('rmux.js');
  const rmux = new Rmux();
  const out = [];
  for (const e of SUPERVISED) {
    const alive = await rmux.hasSession(e.session).catch(() => false);
    const age = heartbeatAge(e.heartbeat);
    out.push({ name: e.name, session: alive, heartbeatAge: age === null ? null : Math.round(age) });
  }
  console.log(JSON.stringify(out, null, 1));
  return 0;
}

// Direct execution when run as its own process entry.
if (process.argv[1] && process.argv[1].endsWith('supervisor-core.mjs')) {
  main(process.argv.slice(2)).then(c => process.exit(c ?? 0), e => { console.error(e?.stack ?? e); process.exit(1); });
}
