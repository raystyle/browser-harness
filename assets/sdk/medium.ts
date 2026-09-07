/**
 * Medium SDK — resident in the medium app tab as `__ms`.
 * Built by scripts/build-sdk.mjs (esbuild, iife, minified) into
 * assets/sdk/medium.min.js; injected by the medium-search command layer.
 *
 * Contract (G002): every method returns a fixed shape {_ok, _v, _ts, ...};
 * failures return {_ok: false, error: '<class>: <detail>'} — never null.
 * Source must stay idempotent: guarded by the __ms existence check.
 *
 * Sync methods only, by measurement (2026-09-07): same-origin fetch of
 * ?format=json serves the first ~2 requests, then Cloudflare hangs later
 * connections and an awaitPromise evaluate never settles. The DOM is the
 * only stable surface; Medium also swaps the <article> subtree mid-hydration,
 * so every extractor reports pending until content is really there.
 */
(() => {
  const g = globalThis as any;
  const V = '1.0.0';
  if (g.__ms && g.__ms.V === V) return;

  const now = () => new Date().toISOString();
  const err = (error: string) => ({ _ok: false as const, _v: V, _ts: now(), error });

  function challenged(): boolean {
    if (/challenges\.cloudflare\.com|cf_chl/.test(location.href)) return true;
    const t = (document.title || '').toLowerCase();
    return /just a moment|attention required|verify you are human|checking your browser|enable javascript and cookies/.test(t);
  }

  /** Readiness judge: on a medium.com host, document complete, not challenged. */
  function ready(): any {
    const onMedium = /(^|\.)medium\.com$/.test(location.hostname);
    return {
      _ok: true as const, _v: V, _ts: now(),
      ready: onMedium && document.readyState === 'complete' && !challenged(),
      challenged: challenged(),
      url: location.href,
    };
  }

  /** Article hrefs end in a 12-hex slug id: /@user/<slug>-<id>?tracking... */
  const SLUG = /-[a-f0-9]{12}(\?|#|$)/;

  function clean(href: string): string {
    try { const u = new URL(href, location.origin); u.search = ''; u.hash = ''; return u.href; } catch { return ''; }
  }

  /**
   * Poll on /search?q=...: pending=true while cards have not rendered,
   * extraction once they have. Card anatomy (2026-09-07 measured): one
   * <article> per hit; h2 = title; the article link is the only a[href]
   * matching SLUG — the other anchors are author/profile links.
   */
  function search_results(top = 10): any {
    if (challenged()) return err('CAPTCHA|WALL: challenge page — complete it manually in the window, then re-run');
    const cards = document.querySelectorAll('article');
    if (location.pathname !== '/search' || cards.length === 0) {
      return { _ok: true as const, _v: V, _ts: now(), pending: true, url: location.href };
    }
    const out: any[] = [];
    const seen = new Set<string>();
    for (const c of cards) {
      const title = String((c.querySelector('h2') as HTMLElement)?.innerText ?? '').trim();
      const href = [...c.querySelectorAll('a[href]')].map((a: any) => String(a.getAttribute('href') || '')).find(h => SLUG.test(h));
      if (!title || !href) continue;
      const url = clean(href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const author = String((c.querySelector('a[href^="/@"]') as HTMLElement)?.innerText ?? '').trim();
      out.push({ title, url, author });
      if (out.length >= top) break;
    }
    return { _ok: true as const, _v: V, _ts: now(), url: location.href, count: out.length, results: out };
  }

  function looksLocked(): boolean {
    if (document.querySelector('[data-testid*="paywall" i]')) return true;
    return /member-only story|become a member|sign up to read|upgrade to keep reading/i.test(document.body.innerText.slice(0, 4000));
  }

  /**
   * Poll on an article page: pending=true while <article> is absent or still
   * a skeleton (<400 chars); LOCKED when the paywall markers are up; full
   * markdown once hydrated. Block walker with a `seen` containment set so
   * nested blocks (li inside ul) are not double-emitted; engagement-button
   * cruft at the top is dropped by the leading-short-block strip.
   */
  function article_body(): any {
    if (challenged()) return err('CAPTCHA|WALL: challenge page — complete it manually in the window, then re-run');
    const article = document.querySelector('article') as HTMLElement | null;
    if (!article) return { _ok: true as const, _v: V, _ts: now(), pending: true, url: location.href };
    const h1 = article.querySelector('h1') as HTMLElement | null;
    const text = article.innerText || '';
    if (!h1 || text.length < 400) {
      if (looksLocked()) return err('LOCKED: member-only article — the DOM shows a truncated preview; retry with a logged-in Medium profile');
      return { _ok: true as const, _v: V, _ts: now(), pending: true, url: location.href };
    }
    const blocks = article.querySelectorAll('h1, h2, h3, h4, p, pre, blockquote, ul, ol, figure');
    const out: string[] = [];
    const seen = new Set<Element>();
    for (const el of blocks) {
      let skip = false;
      for (const s of seen) { if (s.contains(el) && s !== el) { skip = true; break; } }
      if (skip) continue;
      seen.add(el);
      const tag = el.tagName;
      const txt = ((el as HTMLElement).innerText || '').trim();
      if (!txt && tag !== 'FIGURE') continue;
      if (tag === 'H1') out.push('# ' + txt);
      else if (tag === 'H2') out.push('## ' + txt);
      else if (tag === 'H3') out.push('### ' + txt);
      else if (tag === 'H4') out.push('#### ' + txt);
      else if (tag === 'PRE') out.push('```\n' + txt + '\n```');
      else if (tag === 'BLOCKQUOTE') out.push(txt.split('\n').map(l => '> ' + l).join('\n'));
      else if (tag === 'UL' || tag === 'OL') {
        const items = [...(el as any).querySelectorAll(':scope > li')].map((li: any, i: number) => (tag === 'OL' ? (i + 1) + '. ' : '- ') + String(li.innerText || '').trim());
        out.push(items.join('\n'));
      } else if (tag === 'FIGURE') {
        const img = el.querySelector('img') as HTMLImageElement | null;
        const cap = el.querySelector('figcaption') as HTMLElement | null;
        if (img && img.src) out.push('![' + String(img.alt || (cap ? cap.innerText.trim() : '')).slice(0, 120) + '](' + img.src + ')');
      } else out.push(txt);
    }
    while (out.length && out[0].length < 12) out.shift();
    const markdown = out.join('\n\n');
    const author = String((article.querySelector('a[href^="/@"]') as HTMLElement)?.innerText ?? '').trim();
    const time = document.querySelector('article time[datetime], time[datetime]') as any;
    return {
      _ok: true as const, _v: V, _ts: now(), url: clean(location.href),
      title: h1.innerText.trim(), author,
      published: time ? (time.getAttribute ? time.getAttribute('datetime') : null) : null,
      blocks: out.length, chars: markdown.length, markdown,
    };
  }

  g.__ms = { V, ready, search_results, article_body };
})();
