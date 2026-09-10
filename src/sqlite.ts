/**
 * x_tweets store on node:sqlite (built in since 22.5, unflagged on 23.4+).
 * DDL is the Python original's verbatim, PLUS idx_tweets_first_seen which the
 * Python version forgot to create — x-search --since/--recent lean on it.
 *
 * D44: local search runs on FTS5 with the vendored wangfenjin/simple
 * tokenizer (jieba segmentation, per-CJK-char index, pinyin colocated).
 * tweets_fts is an EXTERNAL-CONTENT vtable over tweets; maintenance is
 * explicit in storeTweets (no triggers — INSERT OR IGNORE's trigger
 * semantics are murky, and storeTweets is the only writer). Legacy rows are
 * indexed by the one-time 'rebuild' when the vtable is first created.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Replace orphaned UTF-16 surrogates with '?' — sqlite chokes on them. */
export function cleanUnicode(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '?');
}

export type Tweet = {
  author: string; handle: string; text: string; posted_at: string; url: string;
};

export function openDb(dbPath: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    // allowExtension (Node ≥22.13) lets ensureSimpleFts load the vendored
    // tokenizer; older runtimes reject the option — open without it and let
    // ensureSimpleFts degrade to the LIKE fallback.
    db = new DatabaseSync(dbPath, { timeout: 30_000, allowExtension: true });
  } catch {
    db = new DatabaseSync(dbPath, { timeout: 30_000 });
  }
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
  // FTS maintenance rides the writer: only rows actually inserted join the
  // index (text is immutable — last_seen_at refreshes never touch it).
  const fts = ftsTableExists(db) ? ensureSimpleFts(db) : false;
  const ftsIns = fts ? db.prepare(`INSERT INTO tweets_fts(rowid, text) VALUES (?, ?)`) : null;
  const now = nowLocal();
  for (const t of tweets) {
    const author = cleanUnicode(t.author.split('\n')[0] ?? '');
    const handle = cleanUnicode(t.handle ?? '');
    const text = cleanUnicode(t.text ?? '');
    const key = t.url ? t.url : `${author}|${text}`;
    const r = ins.run(author, handle, text, cleanUnicode(t.posted_at), cleanUnicode(t.url), key, now, now);
    if (Number(r.changes) > 0) {
      inserted++;
      if (ftsIns) ftsIns.run(Number(r.lastInsertRowid), text);
    } else {
      upd.run(now, key);
    }
  }
  return inserted;
}

export function tableExists(db: DatabaseSync): boolean {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tweets'`).get();
  return !!r;
}

// ---------------------------------------------------------------------------
// simple tokenizer + FTS5 (D44)
// ---------------------------------------------------------------------------

/**
 * The vendored simple extension binary for this platform (BH_SIMPLE_EXT
 * overrides — tests use it to exercise the fallback contract). Null when the
 * platform has no vendored binary: callers fall back to LIKE.
 */
export function simpleExtPath(): string | null {
  if (process.env.BH_SIMPLE_EXT) return process.env.BH_SIMPLE_EXT;
  const map: Record<string, string> = {
    'win32-x64': path.join(PKG_DIR, 'assets', 'bin', 'simple', 'windows-x64', 'simple.dll'),
    'linux-x64': path.join(PKG_DIR, 'assets', 'bin', 'simple', 'linux-x64', 'libsimple.so'),
    'darwin-x64': path.join(PKG_DIR, 'assets', 'bin', 'simple', 'osx-x64', 'libsimple.dylib'),
    'darwin-arm64': path.join(PKG_DIR, 'assets', 'bin', 'simple', 'osx-arm64', 'libsimple.dylib'),
  };
  const p = map[`${process.platform}-${process.arch}`];
  return p && existsSync(p) ? p : null;
}

/** Shared jieba dictionary directory (LF variants, one copy for all platforms). */
function simpleDictDir(): string {
  return process.env.BH_SIMPLE_DICT ?? path.join(PKG_DIR, 'assets', 'bin', 'simple', 'dict');
}

function ftsTableExists(db: DatabaseSync): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tweets_fts'`).get();
}

/**
 * Load the simple tokenizer and stand up tweets_fts. Idempotent, and MUST run
 * before any tweets_fts use — even an existing vtable needs its tokenizer
 * registered per connection. Creates the external-content vtable and rebuilds
 * legacy rows on first sight. False = unavailable (no binary / no FTS5 /
 * load failed): search keeps the LIKE path.
 */
export function ensureSimpleFts(db: DatabaseSync): boolean {
  const ext = simpleExtPath();
  if (!ext) return false;
  try {
    db.loadExtension(ext);
    // The tokenizer's jieba defaults to ./dict/ (CWD-relative) — pin it to
    // the vendored copy BEFORE the first jieba_query() constructs its Jieba.
    db.prepare('SELECT jieba_dict(?)').get(simpleDictDir());
    if (!ftsTableExists(db)) {
      db.exec(`CREATE VIRTUAL TABLE tweets_fts USING fts5(text, content='tweets', content_rowid='id', tokenize='simple')`);
      db.exec(`INSERT INTO tweets_fts(tweets_fts) VALUES ('rebuild')`);
    } else {
      // Drift heal: rows written while the index was absent (no binary on the
      // writer's platform, manual sqlite edits) would silently miss. COUNT
      // compare is two cheap scans; rebuild is the only correct repair.
      const drift = db.prepare(`SELECT (SELECT COUNT(*) FROM tweets) - (SELECT COUNT(*) FROM tweets_fts) AS d`).get() as { d?: number } | undefined;
      if (Number(drift?.d ?? 0) !== 0) db.exec(`INSERT INTO tweets_fts(tweets_fts) VALUES ('rebuild')`);
    }
    return true;
  } catch {
    return false;
  }
}

/** Inventory for round logs: total rows + earliest/latest post times.
 *  NULLIF: some posts carry no timestamp (ads/promoted) — '' must not
 *  become the "earliest" via string sort. */
export function tweetStats(db: DatabaseSync): { total: number; earliest: string; latest: string } {
  const r = db.prepare(`SELECT COUNT(*) AS c, MIN(NULLIF(posted_at, '')) AS a, MAX(NULLIF(posted_at, '')) AS m FROM tweets`).get() as { c?: number; a?: string | null; m?: string | null } | undefined;
  return { total: Number(r?.c ?? 0), earliest: String(r?.a ?? ''), latest: String(r?.m ?? '') };
}
