/**
 * x-monitor launcher — idempotent, non-blocking, NO business loop.
 * Brings up the agent Chrome, pins the x-monitor daemon to it, then hands
 * supervision to the rmux session x-supervisor (which keeps x-worker alive).
 *
 * Usage: bh x-monitor
 */

import { importDist } from './x-lib.mjs';

export async function main(argv = [], ctx) {
  try {
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
    await rmux.ensureSession('x-supervisor', {
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
