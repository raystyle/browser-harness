/**
 * x-monitor launcher — idempotent, non-blocking, NO business loop.
 * Brings up the agent Chrome, pins the x-monitor daemon to it, then hands
 * supervision to the rmux session x-supervisor (which keeps x-worker alive).
 *
 * Usage: bh x-monitor [start]    start (idempotent; bare invocation works too)
 *        bh x-monitor stop|close tear the whole supervision stack down
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { importDist, bhHome } from './x-lib.mjs';

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
    const rec = JSON.parse(readFileSync(path.join(bhHome(), 'runtime', 'bh-x-monitor.port'), 'utf8'));
    if (typeof rec.port === 'number') {
      const res = await fetch(`http://127.0.0.1:${rec.port}/quit`, { method: 'POST' }).catch(() => null);
      stopped.push(res ? `x-monitor daemon (:${rec.port}) stopped` : `x-monitor daemon (:${rec.port}) not answering (already down)`);
    }
  } catch { /* no registry record — never started */ }
  const report = stopped.length ? stopped : ['nothing to stop (no sessions, no daemon)'];
  console.log(report.map(l => `x-monitor stop: ${l}`).join('\n'));
  return 0;
}

export async function main(argv = [], ctx) {
  try {
    const sub = argv.find(a => !a.startsWith('-'));
    if (sub === 'stop' || sub === 'close') return await stop();
    // 'start' or bare invocation — idempotent bring-up either way.

    process.env.BH_NAME = process.env.BH_NAME ?? 'x-monitor'; // dedicated daemon
    const { launchAgentChrome, agentCdpUrl } = await importDist('agentChrome.js');
    const { Rmux } = await importDist('rmux.js');

    if (!(await launchAgentChrome())) {
      process.stderr.write(`bh: x-monitor could not start the agent Chrome on ${agentCdpUrl()} — run \`bh chrome start\`, then retry\n`);
      return 1;
    }
    process.env.BH_CDP_URL = process.env.BH_CDP_URL ?? agentCdpUrl();

    const supervisor = new URL('./x-supervisor.mjs', import.meta.url);
    const rmux = new Rmux();
    await rmux.ensureSession(SUPERVISOR_SESSION, {
      command: `"${process.execPath}" "${supervisor.pathname.replace(/^\/([A-Za-z]:)/, '$1')}"`,
      readyTimeout: 20,
    });
    console.log('x-monitor running (supervisor in rmux session "x-supervisor"; db at <workspace>/x_tweets.db)');
    return 0;
  } catch (e) {
    process.stderr.write(`bh: x-monitor failed: ${e?.message ?? e}\n`);
    return 1;
  }
}
