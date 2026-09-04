/**
 * x_tweets store on node:sqlite (built in since 22.5, unflagged on 23.4+).
 * DDL is the Python original's verbatim, PLUS idx_tweets_first_seen which the
 * Python version forgot to create — x-search --since/--recent lean on it.
 */

import { DatabaseSync } from 'node:sqlite';

/** Replace orphaned UTF-16 surrogates with '?' — sqlite chokes on them. */
export function cleanUnicode(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '?');
}

export type Tweet = {
  author: string; handle: string; text: string; posted_at: string; url: string;
};

export function openDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { timeout: 30_000 });
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tweets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author TEXT NOT NULL DEFAULT '',
      handle TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      posted_at TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      dedup_key TEXT NOT NULL UNIQUE,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tweets_posted_at  ON tweets(posted_at);
    CREATE INDEX IF NOT EXISTS idx_tweets_first_seen ON tweets(first_seen_at);
  `);
  return db;
}

/** Local-time, second precision, no timezone suffix (Python parity). */
function nowLocal(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** INSERT OR IGNORE + refresh last_seen_at. Returns 1 when newly inserted. */
export function storeTweets(db: DatabaseSync, tweets: Tweet[]): number {
  let inserted = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO tweets (author, handle, text, posted_at, url, dedup_key, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare(`UPDATE tweets SET last_seen_at = ? WHERE dedup_key = ?`);
  const now = nowLocal();
  for (const t of tweets) {
    const author = cleanUnicode(t.author.split('\n')[0] ?? '');
    const handle = cleanUnicode(t.handle ?? '');
    const text = cleanUnicode(t.text ?? '');
    const key = t.url ? t.url : `${author}|${text}`;
    const r = ins.run(author, handle, text, cleanUnicode(t.posted_at), cleanUnicode(t.url), key, now, now);
    if (Number(r.changes) > 0) inserted++;
    else upd.run(now, key);
  }
  return inserted;
}

export function tableExists(db: DatabaseSync): boolean {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tweets'`).get();
  return !!r;
}
