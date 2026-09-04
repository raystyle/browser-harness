/**
 * web-fetch — fetch a URL's readable content.
 * Plain HTTP first; escalates to a real browser tab when the body is empty,
 * wall-worded, or too thin (<20 words). `--browser` forces the browser path.
 *
 * Usage:
 *   bh web-fetch <url> [--markdown|--text] [--browser]
 *   bh web-fetch --current          (extract the attached tab instead)
 */

export async function main(argv = [], ctx) {
  const h = ctx.browserHelpers;
  const args = argv.filter(a => !a.startsWith('-'));
  const flags = new Set(argv.filter(a => a.startsWith('-')));
  if (flags.has('--current')) {
    const out = await h.extract_page_content();
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  const url = args[0];
  if (!url) {
    process.stderr.write('bh: usage: bh web-fetch <url> [--markdown|--text] [--browser] | --current\n');
    return 2;
  }
  const out = await h.extract_url_content(url, flags.has('--browser'));
  if (flags.has('--markdown') || flags.has('--text')) {
    console.log(out.text);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
  return 0;
}
