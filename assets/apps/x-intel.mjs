/**
 * x-intel launcher — the X MONITOR app (D46: search moved to x-search).
 * Idempotent, non-blocking, NO business loop. Verifies the user's browser
 * is attachable (D11: no spawn), then starts the worker in rmux session
 * "x-intel". Healing belongs to supervisor-core (generic guardian), not
 * an in-app supervisor.
 *
 * Usage: bh x-intel [start]    start the worker (idempotent)
 *        bh x-intel stop|close stop worker + dedicated daemon
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDist, bhHome, dataDir } from './x-intel/lib.mjs';

export const description = '监控你已打开的 X 主页时间线并自动收割新帖入库。';
export const resident = true;
export const selfManaged = true; // dedicated BH_NAME=x-intel daemon; never the default

const WORKER_SESSION = process.env.X_RMUX_SESSION ?? 'x-intel';
const LEGACY_SESSIONS = ['x-monitor']; // D46 pre-split session name, killed on start/stop

function writeStatus(st) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path.join(dataDir(), 'x-intel.status.json'), JSON.stringify({
      _v: '1.0.0', ts: new Date().toISOString(), ...st,
    }));
  } catch { /* best-effort */ }
}

function workerCommand() {
  const entry = fileURLToPath(import.meta.url);
  return `"${process.execPath}" "${entry}" worker`;
}

async function stop() {
  const { Rmux } = await importDist('rmux.js');
  const rmux = new Rmux();
  const stopped = [];
  // Persist stopped first so supervisor-core will not respawn the worker.
  writeStatus({ state: 'stopped', metrics: [] });
  for (const session of [WORKER_SESSION, ...LEGACY_SESSIONS]) {
    if (await rmux.hasSession(session)) {
      await rmux.killSession(session);
      stopped.push(`session "${session}" killed`);
    }
  }
  try {
    const rec = JSON.parse(readFileSync(path.join(bhHome(), 'runtime', 'bh-x-intel.port'), 'utf8'));
    if (typeof rec.port === 'number') {
      const res = await fetch(`http://127.0.0.1:${rec.port}/quit`, { method: 'POST' }).catch(() => null);
      stopped.push(res ? `x-intel daemon (:${rec.port}) stopped` : `x-intel daemon (:${rec.port}) not answering (already down)`);
    }
  } catch { /* no registry record — never started */ }
  const report = stopped.length ? stopped : ['nothing to stop (no sessions, no daemon)'];
  console.log(report.map(l => `x-intel stop: ${l}`).join('\n'));
  return 0;
}

export async function main(argv = [], ctx) {
  try {
    const sub = argv.find(a => !a.startsWith('-'));
    if (sub === 'supervisor') {
      process.stderr.write('bh: x-intel 不再内嵌 supervisor — 由 supervisor-core 守护 worker。请用 `bh x-intel start`\n');
      return 2;
    }
    if (sub === 'worker') { await import('./x-intel/worker.mjs'); await new Promise(() => {}); }
    if (sub === 'search' || sub === 'harvest') {
      // D46 split CTA: these lanes moved to the standalone x-search app.
      const rest = argv.filter(a => a !== sub).join(' ');
      process.stderr.write(`bh: x-intel 只管监控 x.com；${sub === 'search' ? '本地库检索' : '全量收割'}已拆到独立应用，直接运行：\n  bh x-search ${sub === 'search' ? rest || '<keyword>|--recent|--since|--stats' : `harvest ${rest}`.trim()}\n`);
      return 2;
    }
    if (sub === 'stop' || sub === 'close') return await stop();

    process.env.BH_NAME = process.env.BH_NAME ?? 'x-intel';
    const { detectBrowsers } = await importDist('session.js');
    const { Rmux } = await importDist('rmux.js');

    const browsers = await detectBrowsers();
    if (browsers.length === 0) {
      process.stderr.write('bh: x-intel found no attachable browser — open your Chrome, visit chrome://inspect/#remote-debugging and enable "Allow remote debugging for this browser instance", then retry (bh attaches your browser; it never starts one)\n');
      return 1;
    }

    const rmux = new Rmux();
    // Drop pre-split leftovers (old session names) if still around.
    for (const s of LEGACY_SESSIONS) {
      if (await rmux.hasSession(s)) await rmux.killSession(s);
    }
    writeStatus({
      state: 'running',
      metrics: [{ label: '检测节奏', value: '6-8 秒随机探测 · 只附着已打开的 x.com 主页，触发后 10 秒内随机抓取' }],
    });
    await rmux.ensureSession(WORKER_SESSION, {
      cwd: bhHome(),
      command: workerCommand(),
      readyTimeout: 20,
    });
    // Cold-boot guardian: runPlugin skips ensureDaemon for selfManaged apps,
    // and the x-intel named daemon never spawns companions either — without
    // this, a worker that dies on a fresh machine stays dead. Idempotent.
    try {
      const supervisor = path.join(path.dirname(fileURLToPath(import.meta.url)), 'supervisor-core.mjs');
      if (existsSync(supervisor)) {
        await rmux.ensureSession('supervisor-core', {
          cwd: bhHome(),
          command: `"${process.execPath}" "${supervisor}"`,
          readyTimeout: 10,
        });
      } else {
        process.stderr.write('bh: supervisor-core missing from workspace — run `bh skill sync`（worker 暂时无人守护）\n');
      }
    } catch { /* best-effort: the worker itself is already up */ }
    console.log('x-intel running (worker in rmux session "x-intel"; supervisor-core heals it; db at <BH_HOME>/data/x_tweets.db)');
    return 0;
  } catch (e) {
    process.stderr.write(`bh: x-intel failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('x-intel.mjs')) {
  main(process.argv.slice(2)).then(c => process.exit(c ?? 0), e => { console.error(e?.stack ?? e); process.exit(1); });
}
