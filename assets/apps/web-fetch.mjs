/**
 * web-fetch — fetch a URL's readable content.
 * Plain HTTP first; escalates to a real browser tab when the body is empty,
 * wall-worded, or too thin (<20 words). `--browser` forces the browser path.
 *
 * Usage:
 *   bh web-fetch <url> [--markdown|--text] [--browser] [--engine]
 *   bh web-fetch --current          (extract the attached tab instead)
 */

export const description = '抓取网页正文，必要时自动升级为真实浏览器渲染。';

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
  // D37: --engine routes through the self-started headless engine daemon.
  if (flags.has('--engine')) {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const home = process.env.BH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.config', 'browser-harness');
    try {
      const rec = JSON.parse(readFileSync(path.join(home, 'runtime', 'bh-headless-engine.port'), 'utf8'));
      const probe = await fetch(`http://127.0.0.1:${rec.port}/health`, { signal: AbortSignal.timeout(1200) });
      if (!probe.ok) throw new Error('engine daemon unhealthy');
    } catch {
      process.stderr.write('bh: engine not running — start it first: bh engine start\n');
      return 1;
    }
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(process.execPath, [process.argv[1], 'web-fetch', url, '--browser'], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, BH_NAME: 'headless-engine' },
    });
    return r.status ?? 1;
  }
  const out = await h.extract_url_content(url, flags.has('--browser'));
  if (flags.has('--markdown') || flags.has('--text')) {
    console.log(out.text);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
  return 0;
}
