/**
 * Site-level helpers on top of the semantic layer: one-tab-per-app bookkeeping,
 * search with wall detection, and content extraction with a browser-escalation
 * path. Blocked ≠ empty results — a wall is a state, not an empty result set.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Helpers } from './helpers.js';
import { isDashboardUrl } from './host.js';

const BLOCK_WORDS = [
  'just a moment', 'attention required', 'verify you are human', 'access denied',
  'checking your browser', 'enable javascript and cookies', 'captcha',
];
const BLOCK_HTML_WORDS = [...BLOCK_WORDS, 'cf-chl', 'challenges.cloudflare.com'];

/** Site-specific content selectors (fallback extraction level). */
const SITE_SELECTORS: Record<string, string> = {
  'github.com': 'article.markdown-body',
  'stackoverflow.com': '#answers, .s-prose, .question .s-prose',
  'wikipedia.org': '#mw-content-text',
  'medium.com': 'article',
  'news.ycombinator.com': '.commtext',
  'reddit.com': ".usertext-body, [data-testid='comment']",
  'docs.python.org': 'div.body',
};

function stderr(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** D33: the defuddle IIFE bundle shipped in the package (lazy, best-effort). */
let extractSdkCache: string | null | undefined;
function extractSdkSource(): string | null {
  if (extractSdkCache !== undefined) return extractSdkCache;
  try {
    extractSdkCache = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sdk', 'extract.min.js'),
      'utf8');
  } catch {
    extractSdkCache = null; // package layout drift — heuristic path still works
  }
  return extractSdkCache;
}

/** HTML -> flowing text (the fallback extractor's strip, reusable). */
function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackWordCount(html: string): number {
  return stripHtmlToText(html).split(/\s+/).filter(Boolean).length;
}

export function createBrowserHelpers(h: Helpers) {
  const appTabs = new Map<string, string>();

  /** One tab per app (exact host or suffix match), reused idempotently. */
  async function ensure_app_tab(app: string, url: string): Promise<string> {
    const host = new URL(url).hostname;
    const tabs = await h.list_tabs(true);
    const existing = tabs.find(t => {
      if (isDashboardUrl(t.url)) return false;
      try { return new URL(t.url).hostname === host || new URL(t.url).hostname.endsWith(`.${host}`); } catch { return false; }
    });
    if (existing) {
      // Re-attach in case another worker moved it.
      await h.switch_tab(existing.targetId, false);
      appTabs.set(app, existing.targetId);
      return existing.targetId;
    }
    const tid = await h.new_tab(url);
    appTabs.set(app, tid);
    return tid;
  }

  /**
   * Ensure the app tab exists AND the SDK source is resident in it: registered
   * via Page.addScriptToEvaluateOnNewDocument (re-injected on every future
   * navigation) plus one immediate evaluate for the current document. The
   * dedup marker is a FINGERPRINT of the source, stored in the page — so a
   * rebuilt SDK re-registers everywhere it is used, one-shot plugin processes
   * never double-register, and a rebuilt tab simply re-registers. Stale
   * registrations from older builds keep replaying on navigation, but the
   * newest build is registered last and its version guard wins.
   */
  async function ensure_app_sdk(app: string, url: string, sdkSource: string): Promise<string> {
    const tid = await ensure_app_tab(app, url);
    let fp = 0;
    for (let i = 0; i < sdkSource.length; i++) fp = (fp * 33 + sdkSource.charCodeAt(i)) >>> 0; // djb2
    const markerKey = JSON.stringify(app);
    const marker = `(globalThis.__bh_sdk ??= {})[${markerKey}] = ${JSON.stringify(String(fp))};`;
    const probe = await h.js(`globalThis.__bh_sdk?.[${markerKey}] === ${JSON.stringify(String(fp))}`);
    if (probe !== true) {
      await h.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `${sdkSource};${marker}` });
      await h.js(`${sdkSource};${marker}`);
    }
    return tid;
  }

  /** Detect Cloudflare/captcha/block states. Detection only — "stop and ask" lives in SKILL.md. */
  async function detect_page_blocks(): Promise<Array<{ type: string; reason: string }>> {
    const out: Array<{ type: string; reason: string }> = [];
    const info = await h.page_info();
    const url: string = (info.url as string) ?? '';
    const title: string = (info.title as string) ?? '';
    if (url.includes('challenges.cloudflare.com') || url.includes('cf_chl')) {
      out.push({ type: 'cloudflare', reason: `url: ${url.slice(0, 80)}` });
    }
    const titleHit = BLOCK_WORDS.find(w => title.toLowerCase().includes(w));
    if (titleHit) out.push({ type: 'block', reason: `title: ${title.slice(0, 80)}` });
    const iframeHit = await h.js(
      `(()=>{for(const f of document.querySelectorAll('iframe')){const s=f.src||'';if(/captcha|hcaptcha|recaptcha|turnstile|challenges.cloudflare/.test(s))return s.slice(0,80);}return null;})()`);
    if (iframeHit) out.push({ type: 'captcha', reason: `iframe: ${iframeHit}` });
    const bodyHead: string = (await h.js(`document.body ? document.body.innerText.slice(0,600) : ''`)) ?? '';
    const bodyHit = BLOCK_WORDS.find(w => bodyHead.toLowerCase().includes(w));
    if (bodyHit) out.push({ type: 'block', reason: `body: contains "${bodyHit}"` });
    const seen = new Set<string>();
    return out.filter(x => (seen.has(x.type + x.reason) ? false : (seen.add(x.type + x.reason), true)));
  }

  async function scan_tabs_for_blocks(): Promise<Array<{ tab: string } & Record<string, unknown>>> {
    const out: Array<{ tab: string } & Record<string, unknown>> = [];
    for (const t of await h.list_tabs(false)) {
      await h.switch_tab(t.targetId, false);
      const blocks = await detect_page_blocks();
      if (blocks.length > 0) out.push({ tab: t.targetId, url: t.url, blocks });
    }
    return out;
  }

  async function google_search(query: string, limit = 10, page = 1): Promise<Array<{ title: string; url: string }>> {
    await ensure_app_tab('google', `https://www.google.com`);
    await h.goto_url(`https://www.google.com/search?q=${encodeURIComponent(query)}${page > 1 ? `&start=${(page - 1) * 10}` : ''}`);
    await h.wait_for_load(20);
    await h.wait_for_element('a[href^="http"]', 10).catch(() => {});
    const blocks = await detect_page_blocks();
    if (blocks.length > 0) {
      stderr(`[google_search] blocked, no results extracted: ${JSON.stringify(blocks)}`);
      return [];
    }
    return await h.js(`(()=>{
      const seen = new Set(); const out = [];
      for (const a of document.links) {
        const href = a.href || '';
        if (href.includes('google.')) continue;
        const title = (a.innerText || '').trim();
        if (title.length < 4) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        out.push({ title, url: href });
        if (out.length >= ${limit}) break;
      }
      return out;
    })()`) ?? [];
  }

  async function bing_search(query: string, limit = 10, page = 1): Promise<Array<{ title: string; url: string; description: string }>> {
    await ensure_app_tab('bing', `https://www.bing.com`);
    await h.goto_url(`https://www.bing.com/search?q=${encodeURIComponent(query)}${page > 1 ? `&first=${(page - 1) * 10 + 1}` : ''}`);
    await h.wait_for_load(20);
    const blocks = await detect_page_blocks();
    if (blocks.length > 0) {
      stderr(`[bing_search] blocked, no results extracted: ${JSON.stringify(blocks)}`);
      return [];
    }
    const raw = await h.js(`(()=>{
      const out = [];
      for (const li of document.querySelectorAll('li.b_algo')) {
        const a = li.querySelector('h2 a'); const p = li.querySelector('p');
        if (!a) continue;
        out.push({ title: (a.innerText||'').trim(), url: a.href, description: (p?.innerText||'').trim() });
        if (out.length >= ${limit}) break;
      }
      return out;
    })()`) ?? [];
    // Bing wraps results in /ck/a redirectors — decode the real target from the u= param.
    for (const r of raw) {
      const u = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(r.url)?.[1];
      if (u) {
        try {
          const b64 = u.replace(/-/g, '+').replace(/_/g, '/');
          r.url = Buffer.from(b64, 'base64').toString('utf8');
        } catch { /* keep the redirector */ }
      }
    }
    return raw;
  }

  /** Strip scripts/styles/boats, cut to main/article/body, decode entities — the fallback extraction level. */
  function fallbackExtract(html: string, url: string): { title: string; text: string; word_count: number; engine: string } {
    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, '');
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
    let host = '';
    try { host = new URL(url).hostname; } catch { /* bare text */ }
    const sel = Object.entries(SITE_SELECTORS).find(([d]) => host.endsWith(d))?.[1];
    if (sel) {
      const m = cleaned.match(new RegExp(`<([a-z0-9-]+)[^>]*(?:id|class)="[^"]*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(',').map(s => s.trim().replace(/^[.#]|[.#].*$/g, '')).join('|')}[^"]*"[^>]*>[\\s\\S]*?<\\/\\1>`, 'i'));
      if (m) cleaned = m[0];
    } else {
      const m = /<(main|article)[\s\S]*?<\/\1>/i.exec(cleaned);
      if (m) cleaned = m[0];
    }
    const text = cleaned
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/\s+/g, ' ')
      .trim();
    // The horse marker (🐴 + space, a surrogate pair) prefixes titles of tabs
    // bh operates — it is OUR UI, never part of the page's content.
    const clean = (s: string) => s.replace(/^\u{1F434} ?/u, '');
    return { title: clean(title), text: clean(text), word_count: text.split(/\s+/).filter(Boolean).length, engine: 'fallback' };
  }

  function looksBlocked(html: string): boolean {
    const low = html.toLowerCase();
    return BLOCK_HTML_WORDS.some(w => low.includes(w));
  }

  /** Extract the current page's content (attached tab). */
  async function extract_page_content(): Promise<Record<string, string | number>> {
    const info = await h.page_info();
    // D33: Defuddle first — it parses the RENDERED document (clean content +
    // metadata + site-specific extractors: GitHub/Wikipedia/Reddit/YouTube…).
    // One-shot evaluation: the self-contained IIFE bundle is prepended to the
    // call, nothing resident. Falls back to the heuristic — never breaks.
    try {
      const bundle = extractSdkSource();
      if (bundle) {
        const r = (await h.js(`(() => { ${bundle}\n return __bh_extract(); })()`)) as Record<string, unknown>;
        if (r && r['_ok'] === true) {
          return {
            title: String(r['title'] ?? ''),
            url: String(info.url ?? ''),
            text: String(r['markdown'] || stripHtmlToText(String(r['content_html'] ?? ''))),
            word_count: Number(r['word_count'] ?? 0) || fallbackWordCount(String(r['content_html'] ?? '')),
            author: String(r['author'] ?? ''),
            published: String(r['published'] ?? ''),
            description: String(r['description'] ?? ''),
            content_html: String(r['content_html'] ?? ''),
            extractor: String(r['extractor'] ?? 'generic'),
            engine: 'defuddle',
          };
        }
      }
    } catch (e) {
      // Observable, not silent: knowing WHY we fell back matters when tuning
      // (usually a still-hydrating tab on a fresh new_tab, occasionally a wall).
      stderr(`web-fetch: defuddle 未命中（${e instanceof Error ? e.message : String(e)}），降级启发式`);
    }
    const html = await h.js('document.documentElement.outerHTML');
    const r = fallbackExtract(String(html ?? ''), String(info.url ?? ''));
    return { ...r, url: String(info.url ?? ''), engine: 'browser' };
  }

  /**
   * Fetch a URL's content: plain HTTP first; escalate to a real browser tab
   * when the body is empty, wall-worded, or too thin (<20 words).
   */
  async function extract_url_content(url: string, use_browser = false): Promise<Record<string, string | number>> {
    if (!use_browser) {
      try {
        const html = await h.http_get(url);
        const r = fallbackExtract(html, url);
        if (r.text && !looksBlocked(html) && r.word_count >= 20) return { ...r, url, engine: 'http' };
      } catch { /* escalate */ }
    }
    const tid = await h.new_tab(url);
    try {
      await h.wait_for_load(30);
      const out = await extract_page_content();
      return { ...out, engine: use_browser ? 'browser' : `${out['engine']}+browser-retry` };
    } finally {
      await h.close_tab(tid);
    }
  }

  return {
    ensure_app_tab, ensure_app_sdk, detect_page_blocks, scan_tabs_for_blocks,
    google_search, bing_search,
    extract_page_content, extract_url_content,
    web_fetch: extract_url_content,
  };
}

export type BrowserHelpers = ReturnType<typeof createBrowserHelpers>;
