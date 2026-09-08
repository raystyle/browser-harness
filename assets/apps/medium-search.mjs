/**
 * medium-search — standard-pattern app (G002/R002): resident __ms SDK,
 * fixed-shape contract, two-step contract for both the search result set
 * and the article body.
 *
 * Usage:
 *   bh medium-search <query> [--top N]    step 1: search, print metrics (results land on disk)
 *   bh medium-search grab <url> [--out F] grab one article to markdown (data lands on disk; --out also writes the file)
 *   bh medium-search pluck [cache]        step 2: read the latest batch (ms_search | ms_article)
 *   bh medium-search ready                readiness probe {_ok, ready, challenged, url}
 *
 * Tab policy (human coexistence, stricter than ensure_app_tab's host-first
 * match): reuse only the daemon's CURRENT tab when it is already on a
 * medium.com host; otherwise open a fresh tab (new_tab recycles a blank
 * current tab). A non-active medium tab — most likely the user's own — is
 * never touched.
 *
 * Caches live in <workspace>/cache/medium/<cache>.json (batch append, max 100).
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
  ? path.join(process.env.BH_BROWSER_WORKSPACE, 'cache', 'medium')
  : path.join(bhHome(), 'browser-workspace', 'cache', 'medium');
const MAX_BATCH = 100;
const USAGE = 'bh: usage: bh medium-search <query> [--top N] | bh medium-search grab <article-url> [--out file] | bh medium-search pluck [cache] | bh medium-search ready';

const MEDIUM_HOST = /(^|\.)medium\.com$/;
const ARTICLE_SLUG = /-[a-f0-9]{12}$/;

export const description = '搜索 Medium 文章并将指定文章正文转换为 Markdown。';

/** @param {string} msg @param {number} [code] */
/** @param {string} msg @param {number} [code] */
function fail(msg, code = 1) { process.stderr.write(`bh: ${msg}\n`); return code; }

/** G002 check: fixed shape + _ok verdict; classified errors keep their exit code. */
/** @param {{_ok?: boolean, _v?: string, _ts?: string, error?: string} | null | undefined} r */
/** @param {Record<string, any> | null | undefined} r */
function check(r) {
  if (r === null || r === undefined) throw new Error('SDK returned null — session may be disconnected; retry the command');
  if (typeof r._ok !== 'boolean' || typeof r._v !== 'string' || typeof r._ts !== 'string') {
    throw new Error(`SDK contract violation (expected {_ok,_v,_ts}): ${JSON.stringify(r).slice(0, 200)}`);
  }
  if (!r._ok) throw classified(r.error || 'unknown SDK error');
  return r;
}

/** Map '<class>: <detail>' to an exit code; WALL never auto-retries. */
/** @param {string} message */
/** @param {string} message */
function classified(message) {
  const code = /^(CAPTCHA\|WALL|LOCKED|AUTHORIZATION):/.test(message) ? 2
    : /^TIMEOUT:/.test(message) ? 4
    : /^NOT_FOUND:/.test(message) ? 3
    : 1;
  return Object.assign(new Error(message), { code });
}

/** @param {string} cache @param {unknown[]} data @param {string} sdkV @param {Record<string, unknown>} [extra] */
/** @param {string} cache @param {any[]} data @param {string} sdkV @param {Record<string, any>} [extra] */
function stash(cache, data, sdkV, extra = {}) {
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
    ...extra,
  };
}

/** @param {string} cache */
/** @param {string} cache */
function pluck(cache) {
  const file = path.join(CACHE_DIR, `${cache}.json`);
  if (!existsSync(file)) throw new Error(`medium-search: no cache '${cache}' — run a search or grab first`);
  const batches = JSON.parse(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(batches[batches.length - 1].data, null, 1));
}

const SDK_FILE = fileURLToPath(new URL('../sdk/medium.min.js', import.meta.url));

/** @param {number} ms */
/** @param {number} ms */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Ensure a medium tab under the strict tab policy, then make the SDK resident
 * (fingerprint dedup + Page.addScriptToEvaluateOnNewDocument replay), same
 * scheme as browser_helpers.ensure_app_sdk but WITHOUT its host-match-first
 * tab grab, which would hijack a user-opened medium tab.
 * Returns the target id; the caller navigates.
 */
async function ensure(h) {
  let tid = /** @type {any} */ (null);
  try {
    const cur = await h.current_tab();
    if (cur && cur.url) { try { if (MEDIUM_HOST.test(new URL(cur.url).hostname)) tid = cur.targetId; } catch { /* odd url */ } }
  } catch { /* not attached yet — new_tab will attach */ }
  if (!tid) tid = await h.new_tab('about:blank');
  const sdk = readFileSync(SDK_FILE, 'utf8');
  let fp = 0;
  for (let i = 0; i < sdk.length; i++) fp = (fp * 33 + sdk.charCodeAt(i)) >>> 0; // djb2
  const markerKey = JSON.stringify('medium');
  const marker = `(globalThis.__bh_sdk ??= {})[${markerKey}] = ${JSON.stringify(String(fp))};`;
  const probe = await h.js(`globalThis.__bh_sdk?.[${markerKey}] === ${JSON.stringify(String(fp))}`);
  if (probe !== true) {
    await h.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `${sdk};${marker}` });
    await h.js(`${sdk};${marker}`);
  }
  return tid;
}

/** Poll an SDK expression until it stops pending; the deadline judges (M008). */
async function poll(h, expr, deadlineMs) {
  const t0 = Date.now();
  let out = /** @type {Record<string, any> | null} */ (null);
  while (Date.now() - t0 < deadlineMs) {
    // Mid-navigation the eval can throw or return null (SDK not yet replayed on
    // the incoming document) — transient, keep polling; the deadline judges.
    let r = /** @type {Record<string, any> | null} */ (null);
    try { r = await h.js(expr); } catch { /* mid-navigation blip */ }
    if (r && typeof r._ok === 'boolean') {
      out = check(r);
      if (!out.pending) break;
    }
    await sleep(500);
  }
  if (!out || out.pending) {
    throw Object.assign(
      new Error(`TIMEOUT: content did not render within ${Math.round(deadlineMs / 1000)}s — run \`bh medium-search ready\` to inspect`),
      { code: 4 });
  }
  return out;
}

/** @param {string[]} [argv] @param {{helpers: any, browserHelpers: any}} ctx */
/** @param {string[]} argv @param {{helpers: any, browserHelpers: any}} ctx */
export async function main(argv = [], ctx) {
  const pos = argv.filter(a => !a.startsWith('-'));
  const [cmd, arg] = pos;

  if (cmd === 'pluck') { try { pluck(arg || 'ms_search'); return 0; } catch (e) { return fail((e instanceof Error ? e.message : String(e))); } }

  const h = ctx.helpers;
  try {
    if (cmd === 'grab') {
      if (!arg) return fail(USAGE, 2);
      let u;
      try { u = new URL(arg); } catch { return fail(`NOT_FOUND: not a URL: ${arg.slice(0, 80)}`, 3); }
      if (!MEDIUM_HOST.test(u.hostname)) return fail(`NOT_FOUND: not a medium.com URL: ${u.hostname}`, 3);
      if (!ARTICLE_SLUG.test(u.pathname.replace(/\/$/, ''))) {
        return fail('NOT_FOUND: not an article URL (expected .../<slug>-<12 hex id>) — find ids via `bh medium-search <query>`', 3);
      }
      const target = u.origin + u.pathname;
      await ensure(h);
      await h.goto_url(target);
      const body = await poll(h, '__ms.article_body()', 25_000);
      const article = {
        title: body.title, author: body.author, published: body.published ?? null, url: body.url,
        chars: body.chars, words: body.markdown.split(/\s+/).filter(Boolean).length, markdown: body.markdown,
      };
      const outFile = argv.find((a, i) => argv[i - 1] === '--out');
      if (outFile) writeFileSync(outFile, article.markdown + '\n', 'utf8');
      const metrics = stash('ms_article', [article], body._v, {
        title: article.title, author: article.author, published: article.published,
        chars: article.chars, words: article.words, out: outFile || null,
      });
      console.log(JSON.stringify(metrics, null, 1));
      return 0;
    }

    await ensure(h);
    const readyR = check(await h.js('__ms.ready()'));
    if (cmd === 'ready') { console.log(JSON.stringify(readyR, null, 1)); return 0; }
    if (readyR.challenged) {
      return fail('CAPTCHA|WALL: medium challenge page is up. Complete it manually in the Chrome window, then re-run. Not retrying automatically.', 2);
    }
    if (!cmd) return fail(USAGE, 2);

    const top = Number(argv.find((a, i) => argv[i - 1] === '--top') ?? 10) || 10;
    await h.goto_url(`https://medium.com/search?q=${encodeURIComponent(cmd)}`);
    const out = await poll(h, `__ms.search_results(${top})`, 20_000);
    console.log(JSON.stringify(stash('ms_search', out.results ?? [], out._v), null, 1));
    return 0;
  } catch (e) {
    const ce = /** @type {{code?: number, message?: string}} */ (e);
    if (ce && typeof ce.code === 'number') return fail(ce.message ?? '', ce.code);
    return fail((e instanceof Error ? e.message : String(e)));
  }
}
