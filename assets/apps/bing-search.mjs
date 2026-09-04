/**
 * bing-search — search via the browser, print results with descriptions.
 *
 * Usage: bh bing-search <query> [--limit N] [--page N]
 */

export async function main(argv = [], ctx) {
  const h = ctx.browserHelpers;
  const query = argv.filter(a => !a.startsWith('-'))[0];
  const limit = Number(argv.find((a, i) => argv[i - 1] === '--limit') ?? 10) || 10;
  const page = Number(argv.find((a, i) => argv[i - 1] === '--page') ?? 1) || 1;
  if (!query) {
    process.stderr.write('bh: usage: bh bing-search <query> [--limit N] [--page N]\n');
    return 2;
  }
  const results = await h.bing_search(query, limit, page);
  results.forEach((r, i) => {
    console.log(`[${i}] ${r.title}`);
    console.log(`    ${r.url}`);
    if (r.description) console.log(`    ${r.description.slice(0, 200)}`);
  });
  return 0;
}
