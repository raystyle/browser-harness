/**
 * x-search launcher (D46) — the X search app, split out of x-intel:
 *   - local library query (FTS5 + simple tokenizer, D44) — no daemon at all
 *   - harvest: time-sliced full X search on its OWN on-demand daemon
 *     (BH_NAME=x-search; spawns when a harvest runs, idle-retires via
 *     BH_IDLE_TIMEOUT). Never touches the monitor app's x-intel daemon.
 *
 * Usage: bh x-search <keyword> [--limit N] [--author X] | --recent | --since <dur> | --stats [--csv]
 *        bh x-search harvest <q> --from YYYY-MM-DD --to YYYY-MM-DD [--step 1d]
 */
export const description = '查 X 本地库（FTS 分词检索）与时间分片全量收割入库。';
export const resident = false; // on-demand: no guardian card, runs land in the app ledger
export const selfManaged = true; // harvest brings up its own daemon; search needs none

export async function main(argv = [], ctx) {
  const sub = argv.find(a => !a.startsWith('-'));
  if (sub === 'harvest') return (await import('./x-search/harvest.mjs')).main(argv.filter(a => a !== 'harvest'), ctx);
  return (await import('./x-search/search.mjs')).main(argv);
}

if (process.argv[1] && process.argv[1].endsWith('x-search.mjs')) {
  main(process.argv.slice(2)).then(c => process.exit(c ?? 0), e => { console.error(e?.stack ?? e); process.exit(1); });
}
