/**
 * x-supervisor — self-healing supervisor loop (runs inside rmux session
 * "x-supervisor"). One beat every X_CHECK_INTERVAL (15s):
 *   session gone       → spawn
 *   heartbeat missing  → kill + 1s + spawn
 *   heartbeat stale    → kill + 1s + spawn
 *   healthy            → log
 * The supervisor itself never dies: each beat is wrapped, errors are logged
 * and the loop continues. Only 3 rmux commands are ever used.
 *
 * Run by rmux (spawned from x-monitor.mjs); debugging: node x-supervisor.mjs
 */

import { appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { importDist, bhHome } from './x-lib.mjs';

const CHECK_INTERVAL = Number(process.env.X_CHECK_INTERVAL ?? 15);
const HEARTBEAT_TIMEOUT = Number(process.env.X_HEARTBEAT_TIMEOUT ?? 120);
const SPAWN_GRACE = Number(process.env.X_SPAWN_GRACE ?? 15);
const SESSION = process.env.X_RMUX_SESSION ?? 'x-monitor';
const WORKSPACE = process.env.BH_BROWSER_WORKSPACE ?? path.join(bhHome(), 'browser-workspace');
const HEARTBEAT = process.env.X_HEARTBEAT ?? path.join(WORKSPACE, 'x_worker.heartbeat');
const SUPERVISOR_LOG = process.env.X_SUPERVISOR_LOG ?? path.join(WORKSPACE, 'x_supervisor.log');

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

function alert(msg) {
  const line = `[${new Date().toISOString()}] [supervisor] ${msg}`;
  console.log(line);
  try { appendFileSync(SUPERVISOR_LOG, line + '\n'); } catch { /* log dir missing */ }
}

/** Heartbeat = file mtime age in seconds; null when the file is missing. */
function heartbeatAge() {
  try {
    return (Date.now() - statSync(HEARTBEAT).mtimeMs) / 1000;
  } catch {
    return null;
  }
}

function localPath(u) {
  return u.pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

async function main() {
  const { Rmux } = await importDist('rmux.js');
  const rmux = new Rmux();
  const workerPath = localPath(new URL('./x-worker.mjs', import.meta.url));

  async function spawnWorker() {
    await rmux.ensureSession(SESSION, { command: `"${process.execPath}" "${workerPath}"`, readyTimeout: 20 });
    alert(`spawned worker session "${SESSION}"`);
    await sleep(SPAWN_GRACE);
  }

  alert(`supervisor started (interval=${CHECK_INTERVAL}s heartbeat_timeout=${HEARTBEAT_TIMEOUT}s)`);
  for (;;) {
    try {
      const alive = await rmux.hasSession(SESSION);
      const age = heartbeatAge();
      if (!alive) {
        alert('session not alive');
        await spawnWorker();
      } else if (age === null) {
        alert('heartbeat missing');
        await rmux.killSession(SESSION);
        await sleep(1);
        await spawnWorker();
      } else if (age > HEARTBEAT_TIMEOUT) {
        alert(`heartbeat stale (${age.toFixed(0)}s old)`);
        await rmux.killSession(SESSION);
        await sleep(1);
        await spawnWorker();
      } else {
        console.log(`[supervisor] healthy (heartbeat ${age.toFixed(0)}s ago)`);
      }
    } catch (e) {
      alert(`supervisor error: ${e?.message ?? e}`);
    }
    await sleep(CHECK_INTERVAL);
  }
}

main().then(code => process.exit(code ?? 0), e => { console.error(e); process.exit(1); });
