/**
 * Plugin loading. A plugin is an ES module in <workspace>/apps/<name>.mjs
 * exporting `main(args: string[]) => number|Promise<number>` — the exec-into-
 * namespace Python contract (with its __name__/__file__ traps) is replaced by
 * dynamic import, where import.meta.url is naturally correct.
 *
 * Workspace overrides: <workspace>/browser_helpers.mjs's named function
 * exports shadow the packaged defaults, merged (never replacing the module).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspaceDir } from './paths.js';

/** Context injected by the runner: helpers pre-bound to a remote host. */
export type PluginCtx = {
  helpers: Record<string, (...a: any[]) => any>;
  browserHelpers: Record<string, (...a: any[]) => any>;
};

export type PluginModule = { main: (args: string[], ctx?: PluginCtx) => number | Promise<number> };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function pluginPath(name: string): string | null {
  if (!NAME_RE.test(name) || name.startsWith('-')) return null; // no `/`, no `\`, no leading dash
  const p = path.join(workspaceDir(), 'apps', `${name}.mjs`);
  return existsSync(p) ? p : null;
}

/** Load and contract-check a plugin. Returns null when it doesn't exist. */
export async function loadPlugin(name: string): Promise<PluginModule | null> {
  const p = pluginPath(name);
  if (!p) return null;
  const mod = await import(`${pathToFileURL(p).href}?t=${Date.now()}`); // cache-bust for workspace edits
  if (typeof mod.main !== 'function') {
    throw new Error(`plugin ${name} must export main(argv, ctx): number — add \`export async function main(argv, ctx) { …; return 0 }\` (no __main__ guard needed)`);
  }
  return mod as PluginModule;
}

/**
 * Merge workspace browser_helpers overrides onto the given globals: named
 * function exports (skipping `_`-prefixed) shadow the packaged defaults.
 * A broken workspace file logs but never blocks startup.
 */
export async function installWorkspaceOverrides(g: typeof globalThis): Promise<string[]> {
  const p = path.join(workspaceDir(), 'browser_helpers.mjs');
  if (!existsSync(p)) return [];
  try {
    const mod = await import(`${pathToFileURL(p).href}?t=${Date.now()}`);
    const applied: string[] = [];
    for (const [name, value] of Object.entries(mod)) {
      if (name.startsWith('_') || typeof value !== 'function') continue;
      (g as any)[name] = value;
      applied.push(name);
    }
    return applied;
  } catch (e: any) {
    process.stderr.write(`[browser_helpers override] ${path.basename(p)} failed to load (packaged defaults stay active): ${String(e?.message ?? e)}\n`);
    return [];
  }
}
