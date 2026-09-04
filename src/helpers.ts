/**
 * Semantic layer — Host-agnostic, snake_case, argument order matching the
 * Python original so the 779 code fences inside domain-skills run as-is.
 * This module must only import ./host.js and ./env.js (never harness.js).
 */

import { MARKER, MARKER_PREFIX, type CdpEvent, type Host } from './host.js';
import { envNumber } from './env.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const INTERNAL = ['chrome://', 'chrome-untrusted://', 'devtools://', 'chrome-extension://', 'about:'];

export type Tab = { targetId: string; target_id: string; url: string; title: string };

export type Helpers = ReturnType<typeof createHelpers>;

// --- key tables (verbatim ports — physical US-layout truth) ----------------

const KEYS: Record<string, [number, string, string]> = { // key → (vk, code, text)
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab', '\t'], Backspace: [8, 'Backspace', ''],
  Escape: [27, 'Escape', ''], Delete: [46, 'Delete', ''], ' ': [32, 'Space', ' '],
  ArrowLeft: [37, 'ArrowLeft', ''], ArrowUp: [38, 'ArrowUp', ''],
  ArrowRight: [39, 'ArrowRight', ''], ArrowDown: [40, 'ArrowDown', ''],
  Home: [36, 'Home', ''], End: [35, 'End', ''],
  PageUp: [33, 'PageUp', ''], PageDown: [34, 'PageDown', ''],
};

const PUNCTUATION_KEYS: Record<string, [string, number]> = { // char → (code, VK_OEM_*)
  '`': ['Backquote', 192], '-': ['Minus', 189], '=': ['Equal', 187],
  '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220],
  ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188],
  '.': ['Period', 190], '/': ['Slash', 191],
};

const SHIFTED_CHARS: Record<string, string> = { // shifted char → unshifted sibling
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
  '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

/** (code, vk, needs_shift) for one printable ASCII char; null when no US physical key exists. */
function printableKey(char: string): [string, number, boolean] | null {
  const unshifted = SHIFTED_CHARS[char] ?? char;
  const needsShift = char in SHIFTED_CHARS || /[A-Z]/.test(char);
  if (/^[a-z]$/i.test(unshifted)) return [`Key${unshifted.toUpperCase()}`, unshifted.toUpperCase().charCodeAt(0), needsShift];
  if (/^[0-9]$/.test(unshifted)) return [`Digit${unshifted}`, unshifted.charCodeAt(0), needsShift];
  const p = PUNCTUATION_KEYS[unshifted];
  if (p) return [p[0], p[1], needsShift];
  return null;
}

// ---------------------------------------------------------------------------

export function createHelpers(host: Host, hooks: { onAction?: (name: string, args: unknown[], ms: number, error?: unknown) => void } = {}) {
  let selectAllModifier: number | null = null;

  /** Trace an action for the recorder (success AND failure) with its real args. */
  async function withTrace<T>(name: string, args: unknown[], fn: () => Promise<T>): Promise<T> {
    if (!hooks.onAction) return fn();
    const t0 = Date.now();
    try {
      const r = await fn();
      hooks.onAction!(name, args, Date.now() - t0);
      return r;
    } catch (e) {
      hooks.onAction!(name, args, Date.now() - t0, e);
      throw e;
    }
  }

  // --- core ---------------------------------------------------------------

  async function cdp(method: string, params: Record<string, unknown> = {}, opts: { sessionId?: string; _response_timeout?: number } = {}): Promise<any> {
    return host.cdp(method, params, {
      sessionId: opts.sessionId,
      timeoutMs: opts._response_timeout ? opts._response_timeout * 1000 : undefined,
    });
  }

  async function drain_events(): Promise<CdpEvent[]> {
    return await host.drainEvents();
  }

  async function js(expression: string, target_id?: string): Promise<any> {
    const evalOpts = { expression, returnByValue: true, awaitPromise: true };
    try {
      if (target_id) {
        // A fresh flatten session per call — iframe targets need isolation.
        const r = await cdp('Target.attachToTarget', { targetId: target_id, flatten: true });
        try {
          const out = await cdp('Runtime.evaluate', evalOpts, { sessionId: r.sessionId });
          return out?.result?.value;
        } finally {
          await cdp('Target.detachFromTarget', { sessionId: r.sessionId }).catch(() => {});
        }
      }
      const out = await cdp('Runtime.evaluate', evalOpts);
      return out?.result?.value;
    } catch (e: any) {
      if (/Illegal return statement/i.test(String(e?.message ?? e))) {
        const out = await cdp('Runtime.evaluate', { ...evalOpts, expression: `(function(){${expression}})()` });
        return out?.result?.value;
      }
      throw e;
    }
  }

  /** Plain HTTP GET with gzip handling and charset detection. Returns the body as text. */
  async function http_get(url: string, headers: Record<string, string> = {}, timeout = 20): Promise<string> {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; browser-harness-ts)', ...headers },
      signal: AbortSignal.timeout(timeout * 1000),
      redirect: 'follow',
    });
    const buf = await res.arrayBuffer();
    const ct = res.headers.get('content-type') ?? '';
    let charset = /charset=([\w-]+)/i.exec(ct)?.[1];
    if (!charset) {
      const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 512));
      charset = /<meta[^>]+charset=['"]?([\w-]+)/i.exec(head)?.[1];
    }
    try {
      return new TextDecoder(charset ?? 'utf-8').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }

  async function wait(seconds = 1): Promise<void> {
    await sleep(seconds * 1000);
  }

  /** Run a CLI app/plugin as a subprocess, inheriting stdio. Non-zero exit raises with the stderr tail. */
  async function run_app(name: string, ...args: string[]): Promise<string> {
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    return await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [cli, name, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = '';
      p.stdout?.on('data', (d: Buffer) => { out += d; });
      p.stderr?.on('data', (d: Buffer) => { err += d; });
      p.on('error', reject);
      p.on('close', code => {
        if (code === 0) resolve(out);
        else reject(new Error(`run_app ${name} exited ${code}: ${err.slice(-500)}`));
      });
    });
  }

  // --- navigation ---------------------------------------------------------

  /** Commit event = verdict. The deadline only guards deadlock — "unknown" is never "failure". */
  async function _adjudicate_lost_navigation(url: string, budgetMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + budgetMs;
    const active = await host.activeSessionId();
    while (Date.now() < deadline) {
      for (const e of await drain_events()) {
        if (e.sessionId !== active || e.method !== 'Page.frameNavigated') continue;
        const frame = e.params?.frame ?? {};
        if (frame.parentId) continue; // sub-frame navigations don't count
        const frameUrl: string = frame.url ?? frame.unreachableUrl ?? '';
        if (frameUrl.startsWith('chrome-error:')) {
          return { errorText: 'navigation failed (chrome-error page)', url: frameUrl, late: true };
        }
        return { frameId: frame.id, url: frameUrl, late: true };
      }
      try {
        const info = await page_info();
        const cur = String(info.url ?? '').split('#')[0];
        if (cur && cur === url.split('#')[0]) return { url, late: true }; // state corroborates when the event was consumed elsewhere
      } catch { /* page unreachable — keep waiting for the event */ }
      await sleep(300);
    }
    throw new Error(`Page.navigate verdict unknown after ${Math.round(budgetMs / 1000)}s — the navigation may still be in flight; do NOT report this as failure`);
  }

  async function goto_url(url: string, opts: { timeout?: number } = {}): Promise<Record<string, unknown>> {
    return withTrace('goto_url', [url], () => gotoUrlInner(url, opts));
  }

  async function gotoUrlInner(url: string, opts: { timeout?: number } = {}): Promise<Record<string, unknown>> {
    const navTimeout = (opts.timeout ?? envNumber('BH_NAVIGATE_TIMEOUT', 30)) * 1000;
    let r: Record<string, unknown>;
    try {
      r = await cdp('Page.navigate', { url }, { _response_timeout: navTimeout / 1000 });
    } catch {
      r = await _adjudicate_lost_navigation(url, envNumber('BH_IPC_TIMEOUT', 5) * 1000);
    }
    if (process.env.BH_DOMAIN_SKILLS === '1') {
      const seg = (new URL(url).hostname.replace(/^www\./, '').split('.')[0]) ?? '';
      const dir = `${host.workspaceDir()}/domain-skills/${seg}`;
      const out: Record<string, unknown> = { ...r };
      try {
        const { readdirSync, statSync } = await import('node:fs');
        const files: string[] = [];
        (function walk(d: string) {
          for (const f of readdirSync(d)) {
            const p = `${d}/${f}`;
            if (statSync(p).isDirectory()) walk(p);
            else if (f.endsWith('.md')) files.push(f);
          }
        })(dir);
        if (files.length > 0) out.domain_skills = files.sort().slice(0, 10);
      } catch { /* no domain skills for this host */ }
      return out;
    }
    return r;
  }

  async function page_info(): Promise<Record<string, unknown>> {
    // A native dialog freezes the page's JS thread — report the dialog instead of evaluating.
    const dialog = await host.pendingDialog();
    if (dialog) return { dialog };
    return await js(`JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})`)
      .then(s => JSON.parse(String(s)));
  }

  /**
   * Input events HANG (never reply) on a tab that was never activated — no
   * widget/focus state until first shown. The Python SKILL documented this as
   * "a timed-out scroll on an attached background tab is evidence the page
   * needs to be visible: activate, retry once". Mechanized here.
   */
  async function withInputRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e: any) {
      if (!/timed out/i.test(String(e?.message ?? e))) throw e;
      const cur = await host.currentTabInfo();
      if (!cur) throw e;
      await cdp('Target.activateTarget', { targetId: cur.targetId });
      await sleep(400);
      return await fn();
    }
  }

  // --- input --------------------------------------------------------------

  function click_at_xy(x: number, y: number, button = 'left', clicks = 1) {
    return withTrace('click_at_xy', [x, y, button, clicks], () => withInputRetry(async () => {
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: clicks });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: clicks });
    }));
  }

  async function type_text(text: string) {
    await cdp('Input.insertText', { text });
  }

  /** Select-all modifier by the browser's OS (not this process's): 4=Meta on macOS, else 2=Ctrl. */
  async function _select_all_modifier(): Promise<number> {
    if (selectAllModifier === null) {
      const ua: string = (await cdp('Browser.getVersion'))?.userAgent ?? '';
      selectAllModifier = /Mac OS X|Macintosh/.test(ua) ? 4 : 2;
    }
    return selectAllModifier;
  }

  /**
   * Fill a framework-managed input (React controlled, Vue v-model, Ember
   * tracked): focus → clear → real key events → synthetic input+change.
   * Clearing dispatches SelectAll directly — NOT via press_key, which always
   * emits a `char` event for single-char keys; with Ctrl/Cmd held that char
   * makes Chrome type a literal "a" instead of selecting all.
   */
  async function fill_input(selector: string, text: string, clear_first = true, timeout = 0) {
    return withTrace('fill_input', [selector, text.slice(0, 32), clear_first, timeout], async () => {
      if (timeout > 0 && !(await wait_for_element(selector, timeout))) {
        throw new Error(`fill_input: element not found: ${JSON.stringify(selector)}`);
      }
      const focused = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();return true;})()`);
      if (!focused) throw new Error(`fill_input: element not found: ${JSON.stringify(selector)}`);
      if (clear_first) {
        const mods = await _select_all_modifier();
        const selectAll: Record<string, unknown> = {
          key: 'a', code: 'KeyA', modifiers: mods,
          windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
          commands: ['SelectAll'],
        };
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...selectAll });
        const { commands: _c, ...upParams } = selectAll;
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...upParams });
        await press_key('Backspace');
      }
      for (const ch of text) await press_key(ch);
      await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})();`);
    });
  }

  /**
   * Modifiers bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift. Named keys and
   * printable chars carry the physical code/vk a real US keyboard sends, so
   * listeners reading e.key, e.code and e.keyCode all agree. A char that
   * needs Shift sets Shift too — unless the caller is composing an Alt/Ctrl/
   * Meta shortcut; there the caller's intent wins.
   */
  async function press_key(key: string, modifiers = 0) {
    let vk = 0, code = '', text = '';
    if (key in KEYS) {
      [vk, code, text] = KEYS[key]!;
    } else if (key.length === 1) {
      text = key;
      const resolved = printableKey(key);
      if (resolved) {
        code = resolved[0]; vk = resolved[1];
        if (resolved[2] && !(modifiers & (1 | 2 | 4))) modifiers |= 8;
      } else {
        code = ''; vk = 0; // CJK/emoji/accented: insert from the char text only
      }
    } else {
      vk = 0; code = key; text = '';
    }
    const base: Record<string, unknown> = { key, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    const shortcut = modifiers & (1 | 2 | 4);
    const printableChar = key.length === 1 && !!text && !shortcut;
    const downParams = printableChar || !text ? base : { ...base, text };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...downParams });
    if (printableChar) {
      const { text: _t, ...charParams } = base;
      await cdp('Input.dispatchKeyEvent', { type: 'char', ...charParams, text });
    }
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async function scroll(x: number, y: number, dy = -300, dx = 0) {
    await withTrace('scroll', [x, y, dy, dx], () => withInputRetry(() => cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy })));
  }

  async function dispatch_key(selector: string, key = 'Enter', event = 'keypress') {
    await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return;e.focus();e.dispatchEvent(new KeyboardEvent(${JSON.stringify(event)},{key:${JSON.stringify(key)},code:${JSON.stringify(key)},keyCode:13,which:13,bubbles:true}));})();`);
  }

  async function upload_file(selector: string, file_path: string | string[]) {
    const doc = await cdp('DOM.getDocument', { depth: -1 });
    const node = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node?.nodeId) throw new Error(`upload_file: element not found: ${JSON.stringify(selector)}`);
    const files = Array.isArray(file_path) ? file_path : [file_path];
    await cdp('DOM.setFileInputFiles', { files, nodeId: node.nodeId });
  }

  // --- visual -------------------------------------------------------------

  /**
   * Save a PNG of the current viewport; returns the FILE PATH (not base64).
   * max_dim downscales via CDP clip scale (zero-dep) — set 1800 on 2× displays
   * to stay under the 2000px/side limit some image-aware LLMs enforce.
   */
  async function capture_screenshot(path?: string, full = false, max_dim?: number): Promise<string> {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const out = path ?? `${host.tmpDir()}/shot.png`;
    const params: Record<string, unknown> = {
      format: 'png',
      captureBeyondViewport: full,
    };
    if (max_dim) {
      try {
        const m = await cdp('Page.getLayoutMetrics');
        const css = full ? (m.cssContentSize ?? m.contentSize) : (m.cssLayoutViewport ?? m.layoutViewport);
        const w = css.width ?? 0, h = css.height ?? 0;
        const scale = Math.min(1, max_dim / Math.max(w, h, 1));
        if (scale < 1 && w > 0 && h > 0) {
          params.clip = { x: 0, y: 0, width: w, height: h, scale };
        }
      } catch { /* fall back to full-resolution capture */ }
    }
    const r = await cdp('Page.captureScreenshot', params, { _response_timeout: host.screenshotTimeoutMs() });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(r.data, 'base64'));
    return out;
  }

  // --- tabs ----------------------------------------------------------------

  function _is_agent_startup_placeholder(title: string | undefined, url: string | undefined): boolean {
    const u = String(url ?? '');
    return String(title ?? '').startsWith('Starting agent ') && (u === '' || u === 'about:blank' || u.startsWith('about:blank#'));
  }

  async function list_tabs(include_chrome = true): Promise<Tab[]> {
    const out: Tab[] = [];
    const r = await cdp('Target.getTargets', {});
    for (const t of r.targetInfos ?? []) {
      if (t.type !== 'page') continue;
      const url = t.url ?? '';
      if (_is_agent_startup_placeholder(t.title, url)) continue;
      if (!include_chrome && INTERNAL.some(p => url.startsWith(p))) continue;
      const title = (t.title ?? '').startsWith(MARKER_PREFIX) ? (t.title ?? '').slice(3) : t.title;
      out.push({ targetId: t.targetId, target_id: t.targetId, url, title: title ?? '' });
    }
    return out;
  }

  async function current_tab(): Promise<Tab> {
    const info = await host.currentTabInfo();
    if (!info) throw new Error('not attached — call switch_tab/new_tab first (cdp_disconnected)');
    return { targetId: info.targetId, target_id: info.targetId, url: info.url, title: info.title };
  }

  function _target_id(target: string | Tab): string {
    if (typeof target === 'string') return target;
    return target.targetId || target.target_id;
  }

  async function activate_tab(target: string | Tab) {
    const tid = _target_id(target);
    await cdp('Target.activateTarget', { targetId: tid });
    return tid;
  }

  async function switch_tab(target: string | Tab, activate = false): Promise<string> {
    return withTrace('switch_tab', [target], async () => {
      const tid = _target_id(target);
      // Unmark the old tab. The horse emoji is a surrogate pair (2 UTF-16
      // units) + space = 3, so slice(3) removes the prefix cleanly.
      await cdp('Runtime.evaluate', { expression: `if(document.title.startsWith('${MARKER_PREFIX}'))document.title=document.title.slice(3)` }).catch(() => {});
      if (activate) await activate_tab(tid);
      const r = await cdp('Target.attachToTarget', { targetId: tid, flatten: true });
      await host.setSession(r.sessionId, tid);
      await cdp('Runtime.evaluate', { expression: `if(!document.title.startsWith('${MARKER}'))document.title='${MARKER} '+document.title` }).catch(() => {});
      return r.sessionId;
    });
  }

  async function new_tab(url = 'about:blank'): Promise<string> {
    return withTrace('new_tab', [url], async () => {
      // Always create blank, THEN goto: passing url to createTarget races with
      // attach — the brief about:blank reads "complete" before navigation
      // starts, so wait_for_load returns a false finish.
      if (url !== 'about:blank') {
        try {
          const cur = await current_tab();
          const curUrl = cur.url ?? '';
          if (curUrl === '' || curUrl === 'about:blank' || curUrl === 'data:text/html,'
            || curUrl.startsWith('about:blank#') || curUrl.startsWith('chrome://newtab')
            || curUrl.startsWith('chrome://new-tab-page') || curUrl.startsWith('edge://newtab') || curUrl.startsWith('about:newtab')) {
            await goto_url(url);
            return cur.targetId;
          }
        } catch { /* not attached yet */ }
      }
      const r = await cdp('Target.createTarget', { url: 'about:blank', background: true });
      await switch_tab(r.targetId);
      if (url !== 'about:blank') await goto_url(url);
      return r.targetId;
    });
  }

  async function close_tab(target?: string | Tab) {
    return withTrace('close_tab', [target], async () => {
      const tid = target === undefined ? (await current_tab()).targetId : _target_id(target);
      await cdp('Target.closeTarget', { targetId: tid });
    });
  }

  async function ensure_real_tab(): Promise<Tab | null> {
    const tabs = await list_tabs(false);
    if (tabs.length === 0) return null;
    try {
      const cur = await current_tab();
      if (cur.url && !INTERNAL.some(p => cur.url.startsWith(p))) return cur;
    } catch { /* fall through to switch */ }
    await switch_tab(tabs[0]!);
    return tabs[0]!;
  }

  async function iframe_target(url_substr: string): Promise<string | null> {
    const r = await cdp('Target.getTargets', {});
    for (const t of r.targetInfos ?? []) {
      if (t.type === 'iframe' && (t.url ?? '').includes(url_substr)) return t.targetId;
    }
    return null;
  }

  // --- wait judges ----------------------------------------------------------

  /** readyState polling; a lost evaluate is "unknown", never failure — this wait's own deadline is the verdict. */
  async function wait_for_load(timeout = 20): Promise<boolean> {
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      try {
        if ((await js('document.readyState')) === 'complete') return true;
      } catch { /* cold-start evaluate touching the budget is unknown, not failure */ }
      await sleep(300);
    }
    return false;
  }

  /**
   * Render-stability verdict via an idempotent probe. The heartbeat is
   * setInterval, NOT rAF: a fully static page produces zero rAF ticks, which
   * would misread "stable" as "frozen" — while a frozen renderer stops even
   * its timers. Quiet + ticking timer = stable; quiet + dead timer = frozen.
   */
  async function wait_for_render(timeout = 10, stable_ms = 400): Promise<boolean> {
    await js(`(()=>{
      if (window.__bh_render) return true;
      const s = { lastMutation: Date.now(), ticks: 0 };
      window.__bh_render = s;
      new MutationObserver(() => { s.lastMutation = Date.now(); })
        .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      setInterval(() => { s.ticks++; }, 100);
      return true;
    })()`).catch(() => {});
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      try {
        const st = await js('JSON.stringify(window.__bh_render ? {q:(Date.now()-window.__bh_render.lastMutation),t:window.__bh_render.ticks} : null)');
        if (st) {
          const { q, t } = JSON.parse(String(st));
          if (t > 0 && q >= stable_ms) return true;
        }
      } catch { /* probe not ready */ }
      await sleep(200);
    }
    return false;
  }

  async function wait_for_element(selector: string, timeout = 10, visible = false): Promise<boolean> {
    const deadline = Date.now() + timeout * 1000;
    const expr = visible
      ? `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;return e.checkVisibility?e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):!!(e.offsetWidth||e.offsetHeight);})()`
      : `!!document.querySelector(${JSON.stringify(selector)})`;
    while (Date.now() < deadline) {
      try {
        if (await js(expr)) return true;
      } catch { /* page mid-navigation */ }
      await sleep(300);
    }
    return false;
  }

  /**
   * In-flight request set from the event stream, filtered to the ACTIVE
   * session (background tabs' Network events don't count). Documented failure
   * modes: long-poll/SSE/analytics beacons never idle; idle ≠ rendered.
   */
  async function wait_for_network_idle(timeout = 8, idle_ms = 500): Promise<boolean> {
    const active = await host.activeSessionId();
    const inflight = new Set<string>();
    let lastActivity = Date.now();
    for (const e of await drain_events()) {
      if (e.sessionId !== active) continue;
      const rid: string | undefined = e.params?.requestId;
      if (e.method === 'Network.requestWillBeSent') { if (rid) inflight.add(rid); lastActivity = Date.now(); }
      else if (e.method === 'Network.loadingFinished' || e.method === 'Network.loadingFailed') { if (rid) inflight.delete(rid); lastActivity = Date.now(); }
      else if (e.method.startsWith('Network.')) lastActivity = Date.now();
    }
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
      await sleep(250);
      for (const e of await drain_events()) {
        if (e.sessionId !== active) continue;
        const rid: string | undefined = e.params?.requestId;
        if (e.method === 'Network.requestWillBeSent') { if (rid) inflight.add(rid); lastActivity = Date.now(); }
        else if (e.method === 'Network.loadingFinished' || e.method === 'Network.loadingFailed') { if (rid) inflight.delete(rid); lastActivity = Date.now(); }
        else if (e.method.startsWith('Network.')) lastActivity = Date.now();
      }
      if (inflight.size === 0 && Date.now() - lastActivity >= idle_ms) return true;
    }
    return false;
  }

  return {
    cdp, drain_events, js, http_get, wait, run_app,
    goto_url, page_info, _adjudicate_lost_navigation,
    click_at_xy, type_text, fill_input, press_key, scroll, dispatch_key, upload_file,
    capture_screenshot,
    list_tabs, current_tab, activate_tab, switch_tab, new_tab, close_tab, ensure_real_tab, iframe_target,
    wait_for_load, wait_for_render, wait_for_element, wait_for_network_idle,
  };
}

/** Install helpers as BARE global names so domain-skills examples run verbatim. */
export function installHelperGlobals(g: typeof globalThis, helpers: Helpers): void {
  for (const [name, fn] of Object.entries(helpers)) {
    if (typeof fn === 'function') (g as any)[name] = fn;
  }
}
