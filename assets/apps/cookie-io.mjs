/**
 * cookies — export/import the attached browser's cookies via CDP storage APIs.
 * File schema "browser-harness-ts-cookies/1", 0600 perms. Full export is
 * refused by default: pass --domain (repeatable) or --all.
 *
 * Usage:
 *   bh cookies export [--domain example.com]... [--all] [--out path]
 *   bh cookies import <path>
 */

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

const SCHEMA = 'browser-harness-ts-cookies/1';

export async function main(argv = [], ctx) {
  const cdp = ctx.helpers.cdp;
  const cmd = argv[0];
  if (cmd === 'export') {
    const domains = argv.filter((a, i) => argv[i - 1] === '--domain');
    const all = argv.includes('--all');
    const out = argv.find((a, i) => argv[i - 1] === '--out') ?? 'cookies.json';
    const { cookies } = await cdp('Storage.getCookies', {});
    let selected = cookies ?? [];
    if (!all) {
      if (domains.length === 0) {
        process.stderr.write('bh: cookies export refuses a full export by default — pass --domain <host> (repeatable) or --all\n');
        return 2;
      }
      selected = selected.filter(c => domains.some(d => (c.domain ?? '').includes(d)));
    }
    const payload = { schema: SCHEMA, exported_at: new Date().toISOString(), cookies: selected };
    writeFileSync(out, JSON.stringify(payload, null, 2));
    try { chmodSync(out, 0o600); } catch { /* POSIX-only nicety */ }
    console.log(`exported ${selected.length} cookies → ${out}`);
    return 0;
  }
  if (cmd === 'import') {
    const p = argv[1];
    if (!p) { process.stderr.write('bh: usage: bh cookies import <path>\n'); return 2; }
    const payload = JSON.parse(readFileSync(p, 'utf8'));
    if (payload.schema !== SCHEMA) {
      process.stderr.write(`bh: unknown cookie file schema ${JSON.stringify(payload.schema)} (expected ${SCHEMA})\n`);
      return 1;
    }
    let ok = 0, failed = 0;
    for (const c of payload.cookies ?? []) {
      try {
        await cdp('Storage.setCookies', { cookies: [c] });
        ok++;
      } catch {
        try { await cdp('Network.setCookie', c); ok++; } catch { failed++; }
      }
    }
    // Verify by re-reading.
    const { cookies } = await cdp('Storage.getCookies', {});
    const have = new Set((cookies ?? []).map(c => `${c.name}|${c.domain}`));
    const verified = (payload.cookies ?? []).filter(c => have.has(`${c.name}|${c.domain}`)).length;
    console.log(`imported ok=${ok} failed=${failed} verified=${verified}/${(payload.cookies ?? []).length}`);
    return failed > 0 ? 1 : 0;
  }
  process.stderr.write('bh: usage: bh cookies export|import ...\n');
  return 2;
}
