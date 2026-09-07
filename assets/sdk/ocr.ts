/**
 * super-ocr page SDK — resident as `__ocr`.
 * Built by scripts/build-sdk.mjs into assets/sdk/ocr.min.js.
 *
 * Locate captcha *images* on the current document (img/canvas/svg/bg).
 * Interactive puzzles (reCAPTCHA / hCaptcha / Turnstile / slider) are
 * reported separately — they are not OCR-able.
 *
 * Contract (G002): every method returns {_ok, _v, _ts, ...};
 * failures return {_ok: false, error: '<class>: <detail>'} — never null.
 */
(() => {
  const g = globalThis as any;
  const V = '1.0.0';
  if (g.__ocr && g.__ocr.V === V) return;

  const now = () => new Date().toISOString();
  const err = (error: string) => ({ _ok: false as const, _v: V, _ts: now(), error });
  const refs = new Map<string, Element>();

  const KW = /captcha|verifycode|vcode|checkcode|authcode|validatecode|vercode|seccode|identifycode|randcode|imgcode|safecode|yzm|validcode|verify-code|verify_code|校验码|验证码|图形码|安全码|图片码|验证码图片/i;
  const NOISE = /logo|avatar|icon|sprite|emoji|favicon|banner|ad[-_]|pixel|beacon|tracking/i;
  const IFRAME_KW = /recaptcha|hcaptcha|turnstile|geetest|funcaptcha|challenges\.cloudflare|captcha/i;
  const WIDGET = '.g-recaptcha, .h-captcha, [data-sitekey], .cf-turnstile, .geetest_holder, .geetest_widget, .nc-container, #nc_1_wrapper, .tcaptcha, .slider-captcha, .captcha-slider, .slide-verify';
  const SLIDER_COPY = /拖动滑块|请按住滑块|slide to (?:verify|continue)|请完成拼图|拼图验证|点击完成验证/;

  function boxOf(el: Element) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x * 100) / 100,
      y: Math.round(r.y * 100) / 100,
      width: Math.round(r.width * 100) / 100,
      height: Math.round(r.height * 100) / 100,
    };
  }

  function nearbyLabel(el: Element): string {
    const aria = String(el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '').trim();
    if (aria) return aria.slice(0, 40);
    const id = el.id;
    if (id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        const t = String(lab?.textContent || '').trim();
        if (t) return t.slice(0, 40);
      } catch { /* invalid id */ }
    }
    let n: Element | null = el.previousElementSibling;
    for (let i = 0; i < 4 && n; i++, n = n.previousElementSibling) {
      const t = String(n.textContent || '').trim().replace(/\s+/g, ' ');
      if (t && t.length < 30) return t.slice(0, 40);
    }
    const p = el.parentElement;
    if (p) {
      const t = String(p.innerText || '').trim().split(/\n/)[0]?.replace(/\s+/g, ' ') ?? '';
      if (t && t.length < 40) return t;
    }
    return '';
  }

  function nearInput(el: Element): boolean {
    const p = el.closest('form, [class*="form"], [class*="login"], [id*="login"]') || el.parentElement;
    if (!p) return false;
    return !!p.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="image"])');
  }

  function blobOf(el: Element): string {
    const img = el as HTMLImageElement;
    return [
      el.id, (el as HTMLElement).className, el.getAttribute('name'),
      el.getAttribute('alt'), el.getAttribute('title'), el.getAttribute('aria-label'),
      (img as any).src, (img as any).currentSrc, el.getAttribute('src'),
    ].map(x => String(x || '')).join(' ');
  }

  function score(el: Element, label: string): number {
    let s = 0;
    const blob = blobOf(el) + ' ' + label;
    if (KW.test(blob)) s += 80;
    if (label && KW.test(label)) s += 40;
    const r = el.getBoundingClientRect();
    if (r.width >= 40 && r.width <= 280 && r.height >= 16 && r.height <= 90) s += 20;
    if (r.width < 16 || r.height < 12 || r.width > 640 || r.height > 220) s -= 40;
    if (NOISE.test(blob)) s -= 50;
    if (nearInput(el)) s += 15;
    if (/^data:image\//.test(String((el as HTMLImageElement).src || ''))) s += 8;
    return s;
  }

  function walk(root: Document | ShadowRoot, acc: Element[]) {
    for (const el of root.querySelectorAll('img, canvas, svg, input[type="image"]')) acc.push(el);
    for (const el of root.querySelectorAll('*')) {
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) walk(sr, acc);
      const bg = getComputedStyle(el).backgroundImage;
      if (/url\(/.test(bg) && KW.test((el.id || '') + ' ' + (el as HTMLElement).className + ' ' + bg)) acc.push(el);
    }
  }

  function kindOf(el: Element): string {
    const tag = el.tagName.toLowerCase();
    if (tag === 'canvas') return 'canvas';
    if (tag === 'svg') return 'svg';
    if (tag === 'img' || (el as HTMLInputElement).type === 'image') return 'img';
    return 'bg';
  }

  function interactive(): { kind: string; reason: string } | null {
    for (const f of document.querySelectorAll('iframe')) {
      const src = String((f as HTMLIFrameElement).src || '');
      if (IFRAME_KW.test(src)) {
        const kind = /recaptcha/.test(src) ? 'recaptcha'
          : /hcaptcha/.test(src) ? 'hcaptcha'
          : /turnstile|challenges\.cloudflare/.test(src) ? 'turnstile'
          : /geetest/.test(src) ? 'geetest'
          : 'iframe';
        return { kind, reason: `iframe ${src.slice(0, 80)}` };
      }
    }
    const w = document.querySelector(WIDGET);
    if (w) {
      const blob = (w.id || '') + ' ' + (w as HTMLElement).className;
      const kind = /recaptcha/.test(blob) ? 'recaptcha'
        : /h-captcha|hcaptcha/.test(blob) ? 'hcaptcha'
        : /turnstile/.test(blob) ? 'turnstile'
        : /geetest/.test(blob) ? 'geetest'
        : /nc-|slider|slide/.test(blob) ? 'slider'
        : 'widget';
      return { kind, reason: `widget ${blob.slice(0, 60)}` };
    }
    const head = String(document.body?.innerText || '').slice(0, 500);
    if (SLIDER_COPY.test(head)) return { kind: 'slider', reason: 'page copy asks for a slider/puzzle' };
    return null;
  }

  function ready(): any {
    return {
      _ok: true as const, _v: V, _ts: now(),
      ready: !!document.body,
      url: location.href,
      title: document.title,
      interactive: interactive(),
    };
  }

  function locate(top = 5): any {
    refs.clear();
    const acc: Element[] = [];
    walk(document, acc);
    const seen = new Set<Element>();
    const ranked: Array<{ el: Element; score: number; label: string }> = [];
    for (const el of acc) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const label = nearbyLabel(el);
      const sc = score(el, label);
      if (sc < 40) continue;
      ranked.push({ el, score: sc, label });
    }
    ranked.sort((a, b) => b.score - a.score);
    const n = Math.max(1, Math.min(20, Number(top) || 5));
    const candidates = ranked.slice(0, n).map((item, i) => {
      const id = `c${i}`;
      refs.set(id, item.el);
      const img = item.el as HTMLImageElement;
      return {
        id,
        kind: kindOf(item.el),
        box: boxOf(item.el),
        src: String(img.currentSrc || img.src || item.el.getAttribute('src') || '').slice(0, 180),
        alt: String(item.el.getAttribute('alt') || '').slice(0, 80),
        label: item.label,
        score: item.score,
        reason: item.score >= 80 ? 'keyword' : (item.label && KW.test(item.label) ? 'label' : 'heuristic'),
      };
    });
    return {
      _ok: true as const, _v: V, _ts: now(),
      url: location.href,
      title: document.title,
      interactive: interactive(),
      count: candidates.length,
      candidates,
    };
  }

  function exportPng(id: string): any {
    const el = refs.get(String(id));
    if (!el) return err(`NOT_FOUND: candidate ${id} — run locate first`);
    try {
      (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
    } catch { /* older chrome */ }
    try {
      const tag = el.tagName.toLowerCase();
      if (tag === 'canvas') {
        const data = (el as HTMLCanvasElement).toDataURL('image/png');
        return { _ok: true as const, _v: V, _ts: now(), mime: 'image/png', via: 'canvas', data: data.slice(data.indexOf(',') + 1), box: boxOf(el) };
      }
      if (tag === 'img' || (el as HTMLInputElement).type === 'image') {
        const img = el as HTMLImageElement;
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || Math.round(img.getBoundingClientRect().width);
        c.height = img.naturalHeight || Math.round(img.getBoundingClientRect().height);
        if (c.width < 2 || c.height < 2) return err('NOT_FOUND: empty image');
        const ctx = c.getContext('2d');
        if (!ctx) return err('NETWORK: no 2d context');
        ctx.drawImage(img, 0, 0);
        const data = c.toDataURL('image/png');
        return { _ok: true as const, _v: V, _ts: now(), mime: 'image/png', via: 'drawImage', data: data.slice(data.indexOf(',') + 1), box: boxOf(el) };
      }
      return { _ok: false as const, _v: V, _ts: now(), error: 'NETWORK: element cannot export pixels — use clip', tainted: false, box: boxOf(el) };
    } catch {
      return { _ok: false as const, _v: V, _ts: now(), error: 'NETWORK: canvas tainted — use clip', tainted: true, box: boxOf(el) };
    }
  }

  g.__ocr = { V, ready, locate, export: exportPng };
})();
