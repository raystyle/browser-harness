/**
 * x-monitor launcher — idempotent, non-blocking, NO business loop.
 * Verifies the user's browser is attachable (D11: no spawn), pins the
 * x-monitor daemon to it, then hands supervision to the rmux session
 * x-supervisor (which keeps x-worker alive). If the user closes their
 * browser, monitoring pauses until it is back — the supervisor only ever
 * restarts the worker, never a browser.
 *
 * Usage: bh x-monitor [start]    start (idempotent; bare invocation works too)
 *        bh x-monitor stop|close tear the whole supervision stack down
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importDist, bhHome } from './x-intel/lib.mjs';

export const description = '持续监控 X 时间线并自动收割新帖到本地数据库。';
export const resident = true; // guardian app: lives in the dashboard 应用监控台

const SUPERVISOR_SESSION = 'x-supervisor';
const WORKER_SESSION = process.env.X_RMUX_SESSION ?? 'x-monitor';

/** Stop order matters: supervisor FIRST (it re-spawns the worker within 15s), then the worker, then the dedicated daemon. */
async function stop() {
  const { Rmux } = await importDist('rmux.js');
  const rmux = new Rmux();
  const stopped = [];
  for (const [label, session] of [['supervisor session', SUPERVISOR_SESSION], ['worker session', WORKER_SESSION]]) {
    if (await rmux.hasSession(session)) {
      await rmux.killSession(session);
      stopped.push(`${label} "${session}" killed`);
    }
  }
  // The x-monitor daemon instance (BH_NAME=x-monitor), if its registry record exists.
  try {
    const rec = JSON.parse(readFileSync(path.join(bhHome(), 'runtime', 'bh-x-intel.port'), 'utf8'));
    if (typeof rec.port === 'number') {
      const res = await fetch(`http://127.0.0.1:${rec.port}/quit`, { method: 'POST' }).catch(() => null);
      stopped.push(res ? `x-monitor daemon (:${rec.port}) stopped` : `x-monitor daemon (:${rec.port}) not answering (already down)`);
    }
  } catch { /* no registry record — never started */ }
  const report = stopped.length ? stopped : ['nothing to stop (no sessions, no daemon)'];
  console.log(report.map(l => `x-monitor stop: ${l}`).join('\n'));
  return 0;
}

export const selfManaged = true; // brings up its own BH_NAME=x-intel daemon; never the default

export async function main(argv = [], ctx) {
  try {
    const sub = argv.find(a => !a.startsWith('-'));
    // Components launch THROUGH the entry with a role argument — one app,
    // one executable: `x-intel.mjs supervisor|worker`. Their loops are
    // long-running: import starts them, then we PARK forever (returning would
    // trigger the entry's process.exit and kill the loop).
    if (sub === 'supervisor') { await import('./x-intel/supervisor.mjs'); await new Promise(() => {}); }
    if (sub === 'worker') { await import('./x-intel/worker.mjs'); await new Promise(() => {}); }
    if (sub === 'search') return (await import('./x-intel/search.mjs')).main(argv.filter(a => a !== 'search'));
    if (sub === 'harvest') return (await import('./x-intel/harvest.mjs')).main(argv.filter(a => a !== 'harvest'));
    if (sub === 'stop' || sub === 'close') return await stop();
    // 'start' or bare invocation — idempotent bring-up either way.

    process.env.BH_NAME = process.env.BH_NAME ?? 'x-intel'; // dedicated daemon
    const { detectBrowsers } = await importDist('session.js');
    const { Rmux } = await importDist('rmux.js');

    // D11 attach model: the browser must be the user's own, with remote
    // debugging enabled. We never start one; we only explain how to enable.
    const browsers = await detectBrowsers();
    if (browsers.length === 0) {
      process.stderr.write('bh: x-monitor found no attachable browser — open your Chrome, visit chrome://inspect/#remote-debugging and enable "Allow remote debugging for this browser instance", then retry (bh attaches your browser; it never starts one)\n');
      return 1;
    }

    const supervisor = new URL('./x-intel.mjs', import.meta.url);
    const rmux = new Rmux();
    await rmux.ensureSession(SUPERVISOR_SESSION, {
      command: `"${process.execPath}" "${supervisor.pathname.replace(/^\/([A-Za-z]:)/, '$1')}" supervisor`,
      readyTimeout: 20,
    });
    console.log('x-intel running (monitor supervisor in rmux session "x-supervisor"; db at <BH_HOME>/data/x_tweets.db)');
    return 0;
  } catch (e) {
    process.stderr.write(`bh: x-monitor failed: ${e?.message ?? e}\n`);
    return 1;
  }
}

// Direct execution (rmux roles): `node x-intel.mjs supervisor|worker|search…`
// — the plugin contract leaves main() uncalled unless driven by bh's plugin
// runner, so self-invoke ONLY when this file is the process entry.
if (process.argv[1] && process.argv[1].endsWith('x-intel.mjs')) {
  main(process.argv.slice(2)).then(c => process.exit(c ?? 0), e => { console.error(e?.stack ?? e); process.exit(1); });
}
