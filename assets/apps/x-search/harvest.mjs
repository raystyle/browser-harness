/**
 * x-harvest — time-sliced FULL harvest, the thing the Python version left as
 * SKILL knowledge. X search serves a fixed supply window (~10–20 hits per
 * query, hot terms included); going dry IS the real bottom, not a capture
 * defect. Full coverage = slicing the window with since:/until: and running
 * the scroll-harvest per slice; the timeline only renders the first article
 * AFTER a scroll, and 3 consecutive no-growth scrolls = slice bottom.
 *
 * Lane rule (D40) — search owns its tab, the monitor never touches it. This
 * run creates ONE fresh background tab for x.com/search, reuses it across
 * slices and closes it when the run ends. It never navigates a tab it did not
 * create (the user's own x.com tab — and even their empty new tab — is off
 * limits) and every eval is PINNED to its own targetId, so the attach-only
 * monitor (worker.mjs) and a human clicking around cannot yank its context.
 * If the human takes the tab over mid-run it is left alone.
 *
 * Usage: bh x-search harvest <query> --from 2026-08-01 --to 2026-09-01 [--step 1d]
 *
 * D46: its OWN on-demand daemon (BH_NAME=x-search, idle-retires via
 * BH_IDLE_TIMEOUT); the monitor app's x-intel daemon is never touched.
 */

import path from 'node:path';
import { importDist, bhHome, dataDir } from './lib.mjs';

process.env.BH_NAME = process.env.BH_NAME ?? 'x-search';
const WORKSPACE = process.env.BH_BROWSER_WORKSPACE ?? path.join(bhHome(), 'browser-workspace');
const DB_PATH = process.env.X_DB ?? path.join(dataDir(), 'x_tweets.db');

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

/** The app's OWN search tab (targetId): opened by us, reused across slices. */
let ownTab = null;

/** Open (or reuse) our own search tab and point it at `url`. */
async function openOwnTab(h, url) {
  if (ownTab) {
    try {
      if ((await h.list_tabs(false)).some(t => t.targetId === ownTab)) {
        await h.switch_tab(ownTab, false);
        await h.goto_url(url);
        return ownTab;
      }
    } catch { /* tab died mid-run — fall through and open a fresh one */ }
  }
  // `new_tab()` with NO url always creates a fresh background target; the
  // blank-tab reuse path is url-driven, and a reused blank tab could be the
  // USER's own empty tab (which we would then hijack and close). Ours must be
  // provably ours: create, then navigate.
  ownTab = await h.new_tab();
  await h.goto_url(url);
  return ownTab;
}

/**
 * Close the tab WE opened — but only while it is still our search tab. If the
 * human navigated it elsewhere they have taken it over; leave it alone.
 */
async function closeOwnTab(h, tid) {
  if (!tid) return;
  try {
    const tab = (await h.list_tabs(false)).find(t => t.targetId === tid);
    if (!tab) return; // already gone
    if (!/^https?:\/\/(www\.)?x\.com\/search/.test(tab.url)) {
      process.stderr.write('[harvest] 搜索 tab 已被用户接管，保留不动\n');
      return;
    }
    await h.close_tab(tid);
    process.stderr.write('[harvest] 搜索 tab 已关闭\n');
  } catch (e) {
    process.stderr.write(`[harvest] 搜索 tab 关闭失败（忽略）：${e instanceof Error ? e.message : String(e)}\n`);
  }
}

export async function main(argv = [], ctx) {
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const query = argv.find(a => !a.startsWith('-'));
  const from = val('--from');
  const to = val('--to');
  const step = val('--step') ?? '1d';
  if (!query || !from || !to) {
    process.stderr.write('bh: usage: bh x-harvest <query> --from YYYY-MM-DD --to YYYY-MM-DD [--step 1d]\n');
    return 2;
  }

  const stepMs = ({ d: 86400, h: 3600, w: 604800 }[/^(\d+)([dhw])$/.exec(step)?.[2] ?? 'd'] ?? 86400) * 1000;
  const { ensureDaemon } = await importDist('admin.js');
  const { remoteHost } = await importDist('remote.js');
  const { createHelpers } = await importDist('helpers.js');
  const sqlite = await importDist('sqlite.js');
  await ensureDaemon();
  const { readFileSync } = await import('node:fs');
  const port = Number(process.env.BH_PORT ?? (JSON.parse(readFileSync(path.join(bhHome(), 'runtime', 'bh-x-search.port'), 'utf8')).port));
  const h = createHelpers(remoteHost(port));

  const t0 = Date.parse(from);
  const t1 = Date.parse(to);
  let total = 0;

  /** One since:/until: slice: point OUR tab at it, scroll-harvest, store. */
  async function harvestSlice(url, since, until) {
    process.stderr.write(`[harvest] ${since} → ${until} … `);
    // D40: our own tab — no sniffing for (and navigating) the user's tab.
    const tid = await openOwnTab(h, url);
    await sleep(6); // timeline renders the first article only after settling

    let all = [];
    let prevH = 0;
    let dry = 0;
    for (let beat = 0; beat < 30 && dry < 3; beat++) {
      const batch = (await h.js(`(()=>{
        const out = [];
        for (const t of document.querySelectorAll('article[data-testid="tweet"]')) {
          const n = (t.querySelector('[data-testid="User-Name"]')?.innerText || '');
          const m = n.match(/@([A-Za-z0-9_]+)/);
          out.push({ name: n.split('\\n')[0].trim(), handle: m ? m[1] : '',
            text: (t.querySelector('[data-testid="tweetText"]')?.innerText || '').trim(),
            time: (t.querySelector('time')?.getAttribute('datetime') || ''),
            link: (t.querySelector('a[href*="/status/"]')?.getAttribute('href') || '') });
        }
        return out;
      })()`, tid)) ?? [];
      all = all.concat(batch);
      await h.js('window.scrollTo(0, document.documentElement.scrollHeight)', tid);
      await sleep(1);
      const height = await h.js('document.documentElement.scrollHeight', tid);
      if (height === prevH) dry++; else { dry = 0; prevH = height; }
    }

    const seen = new Set();
    const unique = all.filter(t => { const k = t.link || `${t.name}|${t.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
    const db = sqlite.openDb(DB_PATH);
    const inserted = sqlite.storeTweets(db, unique.map(t => ({
      author: t.name ?? '', handle: t.handle ?? '', text: t.text ?? '',
      posted_at: t.time ?? '', url: t.link ? `https://x.com${t.link.startsWith('/') ? t.link : '/' + t.link}` : '',
    })));
    db.close();
    process.stderr.write(`+${inserted} (raw ${unique.length})\n`);
    return inserted;
  }

  try {
    for (let start = t0; start < t1; start += stepMs) {
      const end = Math.min(start + stepMs, t1);
      const since = new Date(start).toISOString().slice(0, 10);
      const until = new Date(end).toISOString().slice(0, 10);
      const url = `https://x.com/search?q=${encodeURIComponent(`${query} since:${since} until:${until}`)}&f=live`;
      total += await harvestSlice(url, since, until);
    }
  } finally {
    await closeOwnTab(h, ownTab); // D40: the tab was ours — take it with us
  }
  const slices = Math.ceil((t1 - t0) / stepMs);
  console.log(JSON.stringify({
    _ok: true, _v: '1.0.0', _ts: new Date().toISOString(),
    inserted: total, slices, db: DB_PATH,
  }, null, 1));
  return 0;
}
