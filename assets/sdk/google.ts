/**
 * Google search SDK — resident in the google app tab as `__gs`.
 * Built by scripts/build-sdk.mjs (esbuild, iife, minified) into
 * assets/sdk/google.min.js; injected by browser_helpers.ensure_app_sdk().
 *
 * Contract (G002): every method returns a fixed shape {_ok, _v, _ts, ...};
 * failures return {_ok: false, error: '<class>: <detail>'} — never null.
 * Source must stay idempotent: it runs once per document (and once more per
 * redundant registration), guarded by the __gs existence check.
 */
(() => {
  const g = globalThis as any;
  const V = '1.1.0';
  // Idempotent per VERSION: reinjection of the same build is a no-op; a bumped
  // build (re-registered by ensure_app_sdk on source-hash change) overwrites.
  // The G002 rule: change SDK behavior -> bump V.
  if (g.__gs && g.__gs.V === V) return;

  const now = () => new Date().toISOString();
  const err = (error: string) => ({ _ok: false as const, _v: V, _ts: now(), error });

  /** Google challenge state: /sorry path or challenge keywords in the title. */
  function challenged(): boolean {
    const u = location.href;
    if (/google\.[a-z.]+\/sorry/.test(u)) return true;
    const t = (document.title || '').toLowerCase();
    return /unusual traffic|not a robot|recaptcha|are you a robot/.test(t);
  }

  function searchBox(): HTMLInputElement | HTMLTextAreaElement | null {
    return document.querySelector('textarea[name="q"], input[name="q"]');
  }

  /** Readiness judge: a search box (or results) present and not challenged. */
  function ready(): any {
    const box = searchBox();
    const hasResults = !!document.querySelector('#search a[href], #rso a[href]');
    const ch = challenged();
    return {
      _ok: true as const, _v: V, _ts: now(),
      ready: (box !== null || hasResults) && !ch,
      challenged: ch,
      url: location.href,
    };
  }

  /** Extract the current results page: [{title, url, snippet}], deduped. */
  function extract(top = 10): any {
    if (challenged()) return err('CAPTCHA|WALL: challenge page — complete it manually in the window, then re-run');
    const out: any[] = [];
    const seen = new Set<string>();
    for (const a of document.querySelectorAll('#search a[href^="http"], #rso a[href^="http"], #main a[href^="http"]') as any) {
      const h3 = a.querySelector('h3, div[role="heading"]');
      const title = String(h3?.textContent ?? a.textContent ?? '').trim();
      const href = String(a.href ?? '');
      if (!title || title.length < 4 || seen.has(href)) continue;
      if (/^(https?:\/\/([a-z0-9-]+\.)*google\.)/i.test(href)) continue; // google-internal links
      seen.add(href);
      // Snippet: nearest sibling text block of the result container (class names
      // churn; structural lookup survives redesigns).
      const cont = a.closest('div.g, div[data-hveid], div[data-sokoban-container]');
      const snippet = String(cont?.querySelector('.VwiC3b, div[data-sncf], span.aCOpRe, div[data-sncf="1"]')?.textContent ?? '').trim();
      out.push({ title, url: href, snippet });
      if (out.length >= top) break;
    }
    return { _ok: true as const, _v: V, _ts: now(), url: location.href, count: out.length, results: out };
  }

  /**
   * Poll on the current document: pending=true while results have not
   * appeared; extraction once they have. Called by the command layer in a
   * loop after goto_url('/search?q=...') — direct navigation beats typing
   * into the React-controlled box (execCommand insertText never reaches its
   * state). The SDK on each new document is the auto-reinjected copy.
   */
  function results(top = 10): any {
    if (challenged()) return err('CAPTCHA|WALL: challenge page — complete it manually in the window, then re-run');
    if (!document.querySelector('#search a[href^="http"], #rso a[href^="http"], #main a[href^="http"]')) {
      return { _ok: true as const, _v: V, _ts: now(), pending: true, url: location.href };
    }
    return extract(top);
  }

  g.__gs = { V, ready, results, extract };
})();
