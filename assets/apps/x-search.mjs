/**
 * x-search — query the local x_tweets.db. Never touches the browser: fresh
 * tweets come from x-monitor; this is the "stored/searched" lane.
 *
 * Usage (exactly one main mode, else usage exit 2):
 *   bh x-search <keyword> [--limit 20] [--author X]
 *   bh x-search --recent [--limit N]
 *   bh x-search --since 30s|10m|1h|2d|1w [--limit N] [--group-by day|hour]
 *   bh x-search --stats
 *   bh x-search <keyword> --csv [--csv-out path]
 */

import path from 'node:path';
import { importDist, bhHome } from './x-lib.mjs';

const WORKSPACE = process.env.BH_BROWSER_WORKSPACE ?? path.join(bhHome(), 'browser-workspace');
const DB_PATH = process.env.X_DB ?? path.join(WORKSPACE, 'x_tweets.db');

function sinceToSeconds(raw) {
  const m = /^(\d+)\s*(s|sec|m|min|h|hr|d|w)?$/i.exec(String(raw).trim());
  if (!m) { process.stderr.write(`bh: bad --since value: ${raw}\n`); process.exit(2); }
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  const mult = { s: 1, sec: 1, m: 60, min: 60, h: 3600, hr: 3600, d: 86400, w: 604800 }[unit] ?? 60;
  return n * mult;
}

export async function main(argv = []) {
  const flags = argv.filter(a => a.startsWith('-'));
  const positional = argv.filter(a => !a.startsWith('-'));
  const val = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

  const keyword = positional[0];
  const author = val('--author');
  const since = val('--since');
  const recent = flags.includes('--recent');
  const stats = flags.includes('--stats');
  const csv = flags.includes('--csv');
  const csvOut = val('--csv-out');
  const groupBy = val('--group-by');
  const limit = Number(val('--limit') ?? 20) || 20;

  const modes = [keyword, since, recent, stats].filter(Boolean).length;
  if (modes === 0) {
    process.stderr.write('bh: usage: bh x-search <keyword> | --recent | --since <dur> | --stats  [--limit N] [--author X] [--group-by day|hour] [--csv]\n');
    return 2;
  }

  const { openDb, tableExists } = await importDist('sqlite.js');
  const db = openDb(DB_PATH);
  try {
    if (!tableExists(db)) { console.log(csv ? 'keyword,author,handle,posted_at,seen,url,text' : '(no data yet — run bh x-monitor)'); return 0; }

    if (stats) {
      const total = db.prepare('SELECT COUNT(*) c FROM tweets').get().c;
      const authors = db.prepare(`SELECT COUNT(DISTINCT handle) c FROM tweets WHERE handle != ''`).get().c;
      const posted = db.prepare('SELECT MIN(posted_at) a, MAX(posted_at) b FROM tweets').get();
      const seen = db.prepare('SELECT MIN(first_seen_at) a, MAX(first_seen_at) b FROM tweets').get();
      const top = db.prepare(`SELECT handle, COUNT(*) c, MAX(first_seen_at) last FROM tweets WHERE handle != '' GROUP BY handle ORDER BY c DESC, last DESC LIMIT 10`).all();
      console.log(JSON.stringify({
        total_tweets: total, distinct_authors: authors,
        posted_range: [posted.a, posted.b], seen_range: [seen.a, seen.b],
        top_authors: top.map(t => ({ handle: t.handle, count: t.c })),
      }, null, 2));
      return 0;
    }

    const where = [];
    const params = [];
    if (keyword) { where.push('text LIKE ?'); params.push(`%${keyword}%`); }
    if (author) {
      where.push('(author LIKE ? OR handle LIKE ?)');
      const a = author.replace(/^@/, '');
      params.push(`%${author}%`, `%${a}%`);
    }
    if (since || recent) {
      const cutoff = new Date(Date.now() - (since ? sinceToSeconds(since) : 5 * 60) * 1000)
        .toISOString().slice(0, 19).replace('T', ' ');
      where.push('first_seen_at >= ?');
      params.push(cutoff);
    }
    const sql = `SELECT * FROM tweets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY first_seen_at DESC, id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit);

    if (csv) {
      const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
      const lines = ['keyword,author,handle,posted_at,seen,url,text'];
      for (const r of rows) lines.push([esc(keyword ?? ''), esc(r.author), esc(r.handle), esc(r.posted_at), esc(r.first_seen_at), esc(r.url), esc(r.text)].join(','));
      const out = lines.join('\n') + '\n';
      if (csvOut) { const { writeFileSync } = await import('node:fs'); writeFileSync(csvOut, out); console.log(`wrote ${rows.length} rows → ${csvOut}`); }
      else process.stdout.write(out);
      return 0;
    }

    if (groupBy === 'day' || groupBy === 'hour') {
      const key = groupBy === 'day' ? 10 : 13;
      const groups = new Map();
      for (const r of rows) {
        const k = String(r.first_seen_at ?? '').slice(0, key);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      for (const [k, rs] of groups) {
        console.log(`== ${k} (${rs.length} tweets) ==`);
        for (const r of rs) console.log(`  [${String(r.first_seen_at ?? '').slice(11, 19)}] ${r.author} (@${r.handle}): ${String(r.text ?? '').slice(0, 110)}`);
      }
      return 0;
    }

    console.log('─'.repeat(60));
    for (const r of rows) {
      console.log(`${r.author} | @${r.handle} | posted ${r.posted_at} | seen ${r.first_seen_at}`);
      console.log(`  ${String(r.text ?? '').slice(0, 320)}`);
      if (r.url) console.log(`  ${r.url}`);
    }
    console.log('─'.repeat(60));
    console.log(`${rows.length} tweet(s)`);
    return 0;
  } finally {
    db.close();
  }
}
