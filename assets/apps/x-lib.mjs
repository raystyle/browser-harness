/**
 * Locate the running bh package's dist/ via the instance registry — the
 * daemon records its own dist path, so provisioned workspace plugins can
 * import package internals (agentChrome/rmux/sqlite) without a package
 * manager in scope. Shared by every x-* app.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function bhHome() {
  return process.env.BH_HOME
    ?? process.env.BROWSER_HARNESS_HOME
    ?? path.join(homedir(), '.config', 'browser-harness');
}

/** dist dir from env override, else daemon records, else the provision stamp. */
export function distDir() {
  if (process.env.BH_DIST) return process.env.BH_DIST;
  for (const name of ['default', 'x-monitor']) {
    try {
      const rec = JSON.parse(readFileSync(path.join(bhHome(), 'runtime', name === 'default' ? 'bh.port' : `bh-${name}.port`), 'utf8'));
      if (rec.dist) return rec.dist;
    } catch { /* not running under this name */ }
  }
  try {
    return readFileSync(path.join(bhHome(), 'runtime', 'dist.path'), 'utf8').trim() + '/dist';
  } catch { /* no stamp */ }
  throw new Error('no bh daemon record found — run `bh --start` (or `bh skill sync`) first so the dist path is recorded');
}

export async function importDist(module) {
  return await import(`${pathToFileURL(path.join(distDir(), module)).href}`);
}
