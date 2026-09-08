/**
 * google-search — standard-pattern app (G002/R002): resident __gs SDK,
 * fixed-shape contract, two-step contract for the result set.
 *
 * Usage:
 *   bh google-search <query> [--top N]   step 1: fetch, print metrics (data lands on disk)
 *   bh google-search pluck [cache]       step 2: read the latest batch's data
 *   bh google-search ready               readiness probe {_ok, ready, challenged, url}
 *
 * Caches live in <workspace>/cache/google/<cache>.json (batch append, max 100).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const bhHome = () => process.env.BH_HOME
  ?? process.env.BROWSER_HARNESS_HOME
  ?? (process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, 'browser-harness')
    : path.join(homedir(), '.config', 'browser-harness'));

const CACHE_DIR = process.env.BH_BROWSER_WORKSPACE
  ? path.join(process.env.BH_BROWSER_WORKSPACE, 'cache', 'google')
  : path.join(bhHome(), 'browser-workspace', 'cache', 'google');
const MAX_BATCH = 100;

export const description = '通过浏览器执行谷歌搜索，结果落盘供分页取用。';
const USAGE = 'bh: usage: bh google-search <query> [--top N] | bh google-search pluck [cache] | bh google-search ready';

/** @param {string} msg @param {number} [code] */
/** @param {string} msg @param {number} [code] */
function fail(msg, code = 1) { process.stderr.write(`bh: ${msg}\n`); return code; }

/** G002 check: fixed shape + _ok verdict; friendly exit on classified errors. */
/** @param {{_ok?: boolean, _v?: string, _ts?: string, error?: string} | null | undefined} r */
/** @param {Record<string, any> | null | undefined} r */
function check(r) {
  if (r === null || r === undefined) throw new Error('SDK returned null — session may be disconnected; retry the command');
  if (typeof r._ok !== 'boolean' || typeof r._v !== 'string' || typeof r._ts !== 'string') {
    throw new Error(`SDK contract violation (expected {_ok,_v,_ts}): ${JSON.stringify(r).slice(0, 200)}`);
  }
  if (!r._ok) throw new Error(r.error || 'unknown SDK error');
  return r;
}

/** @param {string} cache @param {unknown[]} data @param {string} sdkV */
/** @param {string} cache @param {any[]} data @param {string} sdkV */
function stash(cache, data, sdkV) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${cache}.json`);
  const batches = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const batch = { _ts: new Date().toISOString(), batch_id: randomUUID(), count: data.length, data };
  batches.push(batch);
  while (batches.length > MAX_BATCH) batches.shift();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(batches));
  renameSync(tmp, file);
  const item0 = data[0] ?? {};
  return {
    _ok: true, _v: sdkV, _ts: batch._ts,
    count: batch.count,
    shape: { item: Object.keys(item0), item_types: Object.fromEntries(Object.entries(item0).map(([k, v]) => [k, typeof v])) },
    bytes: Buffer.byteLength(JSON.stringify(data)),
    cache, batch_id: batch.batch_id, total_batches: batches.length,
  };
}

/** @param {string} cache */
/** @param {string} cache */
function pluck(cache) {
  const file = path.join(CACHE_DIR, `${cache}.json`);
  if (!existsSync(file)) throw new Error(`google-search: no cache '${cache}' — run a search first`);
  const batches = JSON.parse(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(batches[batches.length - 1].data, null, 1));
}

const SDK_FILE = fileURLToPath(new URL('../sdk/google.min.js', import.meta.url));

/** @param {string[]} [argv] @param {{helpers: any, browserHelpers: any}} ctx */
/** @param {string[]} argv @param {{helpers: any, browserHelpers: any}} ctx */
export async function main(argv = [], ctx) {
  const pos = argv.filter(a => !a.startsWith('-'));
  const [cmd, arg] = pos;

  if (cmd === 'pluck') { try { pluck(arg || 'gs_search'); return 0; } catch (e) { return fail((e instanceof Error ? e.message : String(e))); } }

  const h = ctx.helpers;
  const sdk = readFileSync(SDK_FILE, 'utf8');
  await ctx.browserHelpers.ensure_app_sdk('google', 'https://www.google.com', sdk);

  const ready = check(await h.js('__gs.ready()'));
  if (cmd === 'ready') { console.log(JSON.stringify(ready, null, 1)); return 0; }
  if (ready.challenged) {
    return fail('CAPTCHA|WALL: google challenge page is up. Complete it manually in the Chrome window, then re-run. Not retrying automatically.', 2);
  }

  if (!cmd) return fail(USAGE, 2);
  const top = Number(argv.find((a, i) => argv[i - 1] === '--top') ?? 10) || 10;
  // Direct navigation to the results URL — typing into the React-controlled
  // box via execCommand never lands (its state stays empty). The SDK resident
  // copy on the arriving document does the extraction.
  await h.goto_url(`https://www.google.com/search?q=${encodeURIComponent(cmd)}`);
  const t0 = Date.now();
  let out;
  while (Date.now() - t0 < 20_000) {
    // Mid-navigation the eval can throw or return null (__gs not yet reinjected
    // on the incoming document) — transient, keep polling; the deadline judges.
    let r = /** @type {Record<string, any> | null} */ (null);
    try { r = await h.js(`__gs.results(${top})`); } catch { /* mid-navigation blip */ }
    if (r && typeof r._ok === 'boolean') {
      out = check(r);
      if (!out.pending) break;
    }
    await new Promise(res => setTimeout(res, 500));
  }
  if (!out || out.pending) return fail('TIMEOUT: results did not appear within 20s — run `bh google-search ready` to inspect', 4);
  console.log(JSON.stringify(stash('gs_search', out.results ?? [], out._v), null, 1));
  return 0;
}
