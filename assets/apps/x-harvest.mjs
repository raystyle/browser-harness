/**
 * x-harvest — time-sliced FULL harvest, the thing the Python version left as
 * SKILL knowledge. X search serves a fixed supply window (~10–20 hits per
 * query, hot terms included); going dry IS the real bottom, not a capture
 * defect. Full coverage = slicing the window with since:/until: and running
 * the scroll-harvest per slice; the timeline only renders the first article
 * AFTER a scroll, and 3 consecutive no-growth scrolls = slice bottom.
 *
 * Usage: bh x-harvest <query> --from 2026-08-01 --to 2026-09-01 [--step 1d] [--limit 20]
 */

import path from 'node:path';
import { importDist, bhHome } from './x-lib.mjs';

process.env.BH_NAME = process.env.BH_NAME ?? 'x-monitor';
const WORKSPACE = process.env.BH_BROWSER_WORKSPACE ?? path.join(bhHome(), 'browser-workspace');
const DB_PATH = process.env.X_DB ?? path.join(WORKSPACE, 'x_tweets.db');

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

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
  const port = Number(process.env.BH_PORT ?? (JSON.parse(readFileSync(path.join(bhHome(), 'runtime', 'bh-x-monitor.port'), 'utf8')).port));
  const h = createHelpers(remoteHost(port));

  const t0 = Date.parse(from);
  const t1 = Date.parse(to);
  let total = 0;
  for (let start = t0; start < t1; start += stepMs) {
    const end = Math.min(start + stepMs, t1);
    const since = new Date(start).toISOString().slice(0, 10);
    const until = new Date(end).toISOString().slice(0, 10);
    const url = `https://x.com/search?q=${encodeURIComponent(`${query} since:${since} until:${until}`)}&f=live`;
    process.stderr.write(`[harvest] ${since} → ${until} … `);

    // open/reuse the search tab
    const tabs = await h.list_tabs(false);
    const tab = tabs.find(t => t.url.includes('/search'));
    if (tab) { await h.switch_tab(tab.targetId, false); await h.goto_url(url); }
    else await h.new_tab(url);
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
      })()`)) ?? [];
      all = all.concat(batch);
      await h.js('window.scrollTo(0, document.documentElement.scrollHeight)');
      await sleep(1);
      const height = await h.js('document.documentElement.scrollHeight');
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
    total += inserted;
    process.stderr.write(`+${inserted} (raw ${unique.length})\n`);
  }
  console.log(`harvest complete: +${total} new tweets across ${Math.ceil((t1 - t0) / stepMs)} slice(s) → ${DB_PATH}`);
  return 0;
}
