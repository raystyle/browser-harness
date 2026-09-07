/**
 * supervisor-core — the generic guardian supervisor (D21).
 *
 * One unified registry of resident apps. Every beat it checks, for each entry,
 * the rmux session liveness and a heartbeat file's age; anything dead or stale
 * is killed and restarted. It publishes the G002 status contract for the
 * dashboard 应用监控信息 card and writes supervision actions to the log rail
 * (应用实时事件).
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const description = '统一守护常驻应用，会话/心跳异常自动重启。';
export const resident = true;

const bhHome = () => process.env.BH_HOME
  ?? process.env.BROWSER_HARNESS_HOME
  ?? path.join(homedir(), '.config', 'browser-harness');
const dataDir = () => process.env.BH_DATA_DIR ?? path.join(bhHome(), 'data');
const workspaceDir = () => process.env.BH_BROWSER_WORKSPACE ?? path.join(bhHome(), 'browser-workspace');

const CHECK_INTERVAL = Number(process.env.SUPERVISOR_CHECK_INTERVAL ?? 15);
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

function distDir() {
  if (process.env.BH_DIST) return process.env.BH_DIST;
  try {
    return path.join(readFileSync(path.join(bhHome(), 'runtime', 'dist.path'), 'utf8').trim(), 'dist');
  } catch { /* no stamp */ }
  return null;
}

async function importDist(module) {
  const d = distDir();
  if (!d) throw new Error('no dist path found — run bh --start or bh skill sync first');
  return await import(`${pathToFileURL(path.join(d, module)).href}`);
}

/**
 * Unified supervision registry. Each entry owns its rmux session, heartbeat
 * file and restart command. Timeouts are seconds.
 */
const SUPERVISED = [
  {
    name: 'page-detect',
    session: 'page-detect',
    heartbeat: 'page-watch.json',
    timeout: 60,
    command: () => {
      const d = distDir();
      const cli = d ? path.join(d, 'cli.js') : null;
      if (!cli) throw new Error('no cli.js path');
      return `"${process.execPath}" "${cli}" --name page-detect page-detect watch --watch-loop --interval 10`;
    },
  },
  {
    name: 'x-intel',
    session: 'x-monitor',
    heartbeat: 'x_worker.heartbeat',
    timeout: 120,
    onDemand: true,
    command: () => `"${process.execPath}" "${path.join(workspaceDir(), 'apps', 'x-intel.mjs')}" worker`,
  },
];

export async function main(argv = [], ctx) {
  if (argv.includes('--once')) return once();

  const { Rmux } = await importDist('rmux.js');
  const rmux = new Rmux();
  const state = Object.fromEntries(SUPERVISED.map(e => [e.name, '未知']));

  logLine(`启动（每 ${CHECK_INTERVAL}s 检查 ${SUPERVISED.length} 个常驻应用）`);
  for (;;) {
    const actions = [];
    try {
      for (const e of SUPERVISED) {
        const alive = await rmux.hasSession(e.session).catch(() => false);
        if (e.onDemand && !alive) {
          // On-demand apps are only supervised while running; a stopped
          // x-intel must not be auto-started by the guardian.
          state[e.name] = '未运行';
          continue;
        }
        const age = heartbeatAge(e.heartbeat);
        const stale = age === null || age > e.timeout;
        if (!alive || stale) {
          state[e.name] = '重启中';
          actions.push(e.name);
          if (alive) await rmux.killSession(e.session).catch(() => {});
          await sleep(1);
          await rmux.ensureSession(e.session, { command: e.command(), readyTimeout: 15 }).catch(() => {});
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
      { label: '监督', value: `${SUPERVISED.length} 应用` },
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
