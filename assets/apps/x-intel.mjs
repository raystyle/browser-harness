/**
 * x-intel launcher — idempotent, non-blocking, NO business loop.
 * Verifies the user's browser is attachable (D11: no spawn), then starts
 * the worker in rmux session "x-monitor". Healing belongs to
 * supervisor-core (generic guardian), not an in-app supervisor.
 *
 * Usage: bh x-intel [start]    start the worker (idempotent)
 *        bh x-intel stop|close stop worker + dedicated daemon
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDist, bhHome, dataDir } from './x-intel/lib.mjs';

export const description = '持续监控 X 时间线并自动收割新帖到本地数据库。';
export const resident = true;
export const selfManaged = true; // dedicated BH_NAME=x-intel daemon; never the default

const WORKER_SESSION = process.env.X_RMUX_SESSION ?? 'x-monitor';
const LEGACY_SUPERVISOR_SESSION = 'x-supervisor';

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
  for (const [label, session] of [
    ['worker session', WORKER_SESSION],
    ['legacy supervisor session', LEGACY_SUPERVISOR_SESSION],
  ]) {
    if (await rmux.hasSession(session)) {
      await rmux.killSession(session);
      stopped.push(`${label} "${session}" killed`);
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
    if (sub === 'search') return (await import('./x-intel/search.mjs')).main(argv.filter(a => a !== 'search'));
    if (sub === 'harvest') return (await import('./x-intel/harvest.mjs')).main(argv.filter(a => a !== 'harvest'));
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
    // Drop the old in-app supervisor if a leftover session is still around.
    if (await rmux.hasSession(LEGACY_SUPERVISOR_SESSION)) {
      await rmux.killSession(LEGACY_SUPERVISOR_SESSION);
    }
    writeStatus({
      state: 'running',
      metrics: [{ label: '检测节奏', value: '5 秒探测 · 触发后 10 秒内随机抓取' }],
    });
    await rmux.ensureSession(WORKER_SESSION, {
      command: workerCommand(),
      readyTimeout: 20,
    });
    console.log('x-intel running (worker in rmux session "x-monitor"; supervisor-core heals it; db at <BH_HOME>/data/x_tweets.db)');
    return 0;
  } catch (e) {
    process.stderr.write(`bh: x-intel failed: ${e?.message ?? e}\n`);
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('x-intel.mjs')) {
  main(process.argv.slice(2)).then(c => process.exit(c ?? 0), e => { console.error(e?.stack ?? e); process.exit(1); });
}
