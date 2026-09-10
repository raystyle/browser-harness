import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDb, storeTweets, ensureSimpleFts, loadSimpleTokenizer, simpleExtPath, type Tweet } from './sqlite.js';

/** Fresh tmp db per test (WAL sidecars go to the same dir; remove recursively). */
function tmpDb(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'bh-sqlite-'));
  return { file: path.join(dir, 't.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tw = (text: string, url: string): Tweet => ({ author: 'a', handle: 'h', text, posted_at: '2026-09-10T00:00:00Z', url });

const MATCH_SQL = `SELECT COUNT(*) c FROM tweets JOIN tweets_fts ON tweets_fts.rowid = tweets.id WHERE tweets_fts MATCH jieba_query(?)`;

describe('simple FTS (D44)', () => {
  test('vendored simple binary exists for this platform', () => {
    assert.ok(simpleExtPath(), 'no vendored binary — search silently degrades to LIKE');
  });

  test('chinese keyword matches word-order-free (the LIKE blind spot)', () => {
    const { file, cleanup } = tmpDb();
    try {
      const db = openDb(file);
      assert.ok(ensureSimpleFts(db));
      storeTweets(db, [tw('我用自动化和浏览器做了个机器人', 'https://x.com/1')]);
      // precondition: contiguous LIKE really misses this row
      const like = db.prepare(`SELECT COUNT(*) c FROM tweets WHERE text LIKE ?`).get('%浏览器自动化%') as { c: number };
      assert.equal(like.c, 0);
      // jieba AND of terms finds it word-order-free
      const hit = db.prepare(MATCH_SQL).get('浏览器自动化') as { c: number };
      assert.equal(hit.c, 1);
      db.close();
    } finally { cleanup(); }
  });

  test('legacy rows are indexed by the first-time rebuild', () => {
    const { file, cleanup } = tmpDb();
    try {
      const db = openDb(file);
      storeTweets(db, [tw('深度学习模型的训练很耗时', 'https://x.com/2')]); // written BEFORE any fts
      assert.ok(ensureSimpleFts(db)); // first sight: create + rebuild
      const n = db.prepare(MATCH_SQL).get('深度学习') as { c: number };
      assert.equal(n.c, 1);
      db.close();
    } finally { cleanup(); }
  });

  test('rows stored AFTER the index exists are searchable (writer maintenance)', () => {
    const { file, cleanup } = tmpDb();
    try {
      const db = openDb(file);
      assert.ok(ensureSimpleFts(db));
      storeTweets(db, [tw('Claude Code drives the browser', 'https://x.com/3')]);
      const n = db.prepare(MATCH_SQL).get('claude') as { c: number };
      assert.equal(n.c, 1);
      db.close();
    } finally { cleanup(); }
  });

  test('duplicate stores keep exactly one row and one index entry', () => {
    const { file, cleanup } = tmpDb();
    try {
      const db = openDb(file);
      assert.ok(ensureSimpleFts(db));
      storeTweets(db, [tw('自动化', 'https://x.com/4')]);
      storeTweets(db, [tw('自动化', 'https://x.com/4')]); // dedup: OR IGNORE + no fts insert
      const rows = db.prepare(`SELECT COUNT(*) c FROM tweets`).get() as { c: number };
      const idx = db.prepare(`SELECT COUNT(*) c FROM tweets_fts`).get() as { c: number };
      assert.equal(rows.c, 1);
      assert.equal(idx.c, 1);
      db.close();
    } finally { cleanup(); }
  });

  test('content-side drift is detected by integrity-check and healed by rebuild', () => {
    const { file, cleanup } = tmpDb();
    try {
      const db = openDb(file);
      assert.ok(ensureSimpleFts(db));
      storeTweets(db, [tw('自动化测试', 'https://x.com/5'), tw('浏览器知识', 'https://x.com/6')]);
      // Simulate manual drift: delete a content row behind the index's back.
      db.exec(`DELETE FROM tweets WHERE url = 'https://x.com/5'`);
      // COUNT(*) on an external-content vtable reads through to tweets — the
      // old count-compare heal could never see this. integrity-check does.
      assert.ok(ensureSimpleFts(db)); // heals via rebuild
      const gone = db.prepare(MATCH_SQL).get('自动化测试') as { c: number };
      const kept = db.prepare(MATCH_SQL).get('浏览器') as { c: number };
      assert.equal(gone.c, 0, 'stale index entry removed by the heal');
      assert.equal(kept.c, 1);
      db.close();
    } finally { cleanup(); }
  });

  test('missing binary degrades to false (LIKE fallback contract)', () => {
    const { file, cleanup } = tmpDb();
    const saved = process.env.BH_SIMPLE_EXT;
    process.env.BH_SIMPLE_EXT = path.join(tmpdir(), 'definitely-missing-simple.dll');
    try {
      const db = openDb(file);
      assert.equal(ensureSimpleFts(db), false);
      db.close();
    } finally {
      if (saved === undefined) delete process.env.BH_SIMPLE_EXT;
      else process.env.BH_SIMPLE_EXT = saved;
      cleanup();
    }
  });
});
