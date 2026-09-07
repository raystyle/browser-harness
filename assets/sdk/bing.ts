/**
 * Bing search SDK — resident in the bing app tab as `__bs`.
 * Built by scripts/build-sdk.mjs into assets/sdk/bing.min.js;
 * injected by browser_helpers.ensure_app_sdk().
 *
 * Contract (G002): every method returns {_ok, _v, _ts, ...};
 * failures return {_ok: false, error: '<class>: <detail>'} — never null.
 */
(() => {
  const g = globalThis as any;
  const V = '1.0.0';
  if (g.__bs && g.__bs.V === V) return;

  const now = () => new Date().toISOString();
  const err = (error: string) => ({ _ok: false as const, _v: V, _ts: now(), error });

  function challenged(): boolean {
    const u = location.href;
    const t = (document.title || '') + ' ' + (document.body?.innerText || '').slice(0, 400);
    if (/\/challenge|\/captcha|sorry/i.test(u)) return true;
    return /unusual traffic|not a robot|verify you are human|请证明您是真人|人机验证|captcha/i.test(t);
  }

  /** Bing wraps organic links in /ck/a?…&u=a1<base64url>. */
  function unwrap(href: string): string {
    const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href);
    if (!m?.[1]) return href;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64 + '==='.slice((b64.length + 3) % 4);
      const decoded = atob(pad);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch { /* keep redirector */ }
    return href;
  }

  function ready(): any {
    const hasAlgo = !!document.querySelector('li.b_algo h2 a');
    const box = document.querySelector('textarea[name="q"], input[name="q"], #sb_form_q');
    const ch = challenged();
    return {
      _ok: true as const, _v: V, _ts: now(),
      ready: (hasAlgo || box !== null) && !ch,
      challenged: ch,
      url: location.href,
    };
  }

  function extract(top = 10): any {
    if (challenged()) return err('CAPTCHA|WALL: bing challenge page — complete it manually in the window, then re-run');
    const out: any[] = [];
    const seen = new Set<string>();
    for (const li of document.querySelectorAll('li.b_algo') as any) {
      const a = li.querySelector('h2 a') as HTMLAnchorElement | null;
      if (!a) continue;
      const title = String(a.innerText || a.textContent || '').trim();
      const url = unwrap(String(a.href || ''));
      if (!title || title.length < 2 || !url || seen.has(url)) continue;
      if (/bing\.com\/(search|ck|aclick)/i.test(url)) continue;
      seen.add(url);
      const snippet = String(li.querySelector('p, .b_caption p, .b_algoSlug')?.textContent || '').trim();
      out.push({ title, url, snippet });
      if (out.length >= top) break;
    }
    return { _ok: true as const, _v: V, _ts: now(), url: location.href, count: out.length, results: out };
  }

  function results(top = 10): any {
    if (challenged()) return err('CAPTCHA|WALL: bing challenge page — complete it manually in the window, then re-run');
    if (!document.querySelector('li.b_algo h2 a')) {
      return { _ok: true as const, _v: V, _ts: now(), pending: true, url: location.href };
    }
    return extract(top);
  }

  g.__bs = { V, ready, results, extract };
})();
