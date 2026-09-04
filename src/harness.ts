/**
 * Harness — the daemon semantics, in-process. Wraps the thin Session
 * transport with everything the Python daemon carried: the event ring
 * buffer, dialog capture, the horse marker, stale-session self-heal,
 * first-page attach policy, default-domain enables and the idle watchdog.
 */

import { tmpDir as bhTmpDir, workspaceDir, DEFAULT_NAME, instanceName, readInstanceRecord } from './paths.js';
import { MARKER, MARKER_PREFIX, type CdpEvent, type Host } from './host.js';
import { Session } from './session.js';
import { agentChromeHeadless, isAgentChromeRunning, launchAgentChrome, readWsUrl, stopAgentChrome } from './agentChrome.js';
import { clamp, envNumber } from './env.js';

const BUF_MAX = 500;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class Harness {
  readonly session: Session;
  private buf: CdpEvent[] = [];
  private dialog: { type: string; message: string; url: string } | null = null;
  private attachedTargetId: string | undefined;
  private replacements: Array<{ from: string; to: string; at: number }> = [];
  private lastUsedAt = Date.now();
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;

  constructor(session: Session) {
    this.session = session;
    session.onEvent((method, params, sessionId) => this.onEvent({ method, params, sessionId }));
    // Browser-level death watch: a closed WS means Chrome went down — try to
    // reconnect (relaunching the agent Chrome); if that fails, exit so
    // ensureDaemon's next round classifies and restarts us with instructions.
    this.wasConnected = false;
    const watcher = setInterval(() => {
      const now = session.isConnected();
      if (this.wasConnected && !now) void this.reconnect();
      this.wasConnected = now;
    }, 5_000);
    watcher.unref?.();
  }

  private wasConnected: boolean;

  private async reconnect(): Promise<void> {
    this.lastReconnectAttempt ??= 0;
    if (Date.now() - this.lastReconnectAttempt < 15_000) return; // rate-limit
    this.lastReconnectAttempt = Date.now();
    try {
      await this.connect();
    } catch (e: any) {
      console.error(`bh: reconnect failed: ${String(e?.message ?? e)}`);
    }
  }

  private lastReconnectAttempt: number | undefined;

  // -------------------------------------------------------------------------
  // Connection + attach
  // -------------------------------------------------------------------------

  /**
   * Resolve and connect: BH_CDP_WS direct → BH_CDP_URL poll /json/version
   * (30s; 403 = permission-blocked) → the dedicated agent Chrome (launch if
   * needed). Then attach the first page per policy.
   */
  async connect(): Promise<void> {
    const wsEnv = process.env.BH_CDP_WS;
    if (wsEnv) {
      await this.session.connect({ wsUrl: wsEnv, timeoutMs: 5_000 });
    } else if (process.env.BH_CDP_URL) {
      const ws = await this.pollCdpUrl(process.env.BH_CDP_URL, 30_000);
      await this.session.connect({ wsUrl: ws, timeoutMs: 5_000 });
    } else {
      if (!(await isAgentChromeRunning())) {
        if (!(await launchAgentChrome())) {
          throw new Error('agent Chrome failed to start — run `bh doctor` and `bh chrome start`');
        }
      }
      const ws = await readWsUrl();
      if (!ws) throw new Error('agent Chrome is running but no WS endpoint resolved (neither DevToolsActivePort nor /json/version)');
      await this.session.connect({ wsUrl: ws.wsUrl, timeoutMs: 5_000 });
    }
    await this.attachFirstPage();
  }

  /** Poll <url>/json/version for webSocketDebuggerUrl. 403 → the Allow-popup instruction. */
  private async pollCdpUrl(base: string, budgetMs: number): Promise<string> {
    const deadline = Date.now() + budgetMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 403) {
          throw new Error('permission-blocked: Chrome is waiting on the "Allow remote debugging?" prompt — ask the user to click Allow, then retry. Do not retry before they confirm.');
        }
        if (res.ok) {
          const j = await res.json() as { webSocketDebuggerUrl?: string };
          if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
          lastErr = 'no webSocketDebuggerUrl in /json/version';
        }
      } catch (e: any) {
        if (String(e?.message ?? '').startsWith('permission-blocked')) throw e;
        lastErr = String(e?.message ?? e);
      }
      await sleep(1000);
    }
    throw new Error(`BH_CDP_URL ${base} did not answer /json/version within ${Math.round(budgetMs / 1000)}s (${lastErr})`);
  }

  /** True when the page looks blank/reusable — a respawn cycle must not leak a new blank tab each time. */
  private isReusableBlank(url: string): boolean {
    return url === '' || url === 'about:blank' || url === 'data:text/html,' || url.startsWith('about:blank#')
      || url.startsWith('chrome://newtab') || url.startsWith('chrome://new-tab-page') || url.startsWith('edge://newtab') || url.startsWith('about:newtab');
  }

  /**
   * Attach the first page. Named instances (BH_NAME set) prefer their own
   * dedicated tab; the default instance prefers a real page, then a reusable
   * blank, then creates one.
   */
  async attachFirstPage(): Promise<{ sessionId: string; targetId: string }> {
    const { targetInfos } = await this.rawBrowserCall('Target.getTargets', {}) as { targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> };
    const pages = targetInfos.filter(t => t.type === 'page');
    const named = instanceName() !== DEFAULT_NAME;

    let pick: string | undefined;
    if (named) {
      // Dedicated tab: previously ours (marked) → any blank orphan → fresh.
      pick = pages.find(t => (t.title ?? '').startsWith(MARKER))?.targetId
        ?? pages.find(t => this.isReusableBlank(t.url))?.targetId;
    } else {
      pick = pages.find(t => !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://') && !this.isReusableBlank(t.url))?.targetId
        ?? pages.find(t => this.isReusableBlank(t.url))?.targetId;
    }
    if (!pick) {
      const r = await this.rawBrowserCall('Target.createTarget', { url: 'about:blank', background: true }) as { targetId: string };
      pick = r.targetId;
    }
    const sid = await this.attachTo(pick);
    return { sessionId: sid, targetId: pick };
  }

  /** Target.attachToTarget flatten + default-domain enables + marker. */
  private async attachTo(targetId: string): Promise<string> {
    const r = await this.rawBrowserCall('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    await this.adoptSession(r.sessionId, targetId);
    return r.sessionId;
  }

  /** Old session Network.disable ∥ new session 4-domain enable, then re-stamp the marker. */
  private async adoptSession(sessionId: string, targetId: string): Promise<void> {
    const old = this.session.getActiveSession();
    this.session.setActiveSession(sessionId);
    this.attachedTargetId = targetId;
    const jobs: Promise<unknown>[] = [];
    if (old) jobs.push(this.rawCall('Network.disable', {}, old).catch(() => {}));
    for (const m of ['Page.enable', 'DOM.enable', 'Runtime.enable', 'Network.enable']) {
      jobs.push(this.rawCall(m, {}, sessionId).catch(() => {}));
    }
    await Promise.all(jobs);
    this.stampMarker();
  }

  /** Prepend the horse marker so the user can see which tab the agent controls. */
  private stampMarker(): void {
    const sid = this.session.getActiveSession();
    if (!sid) return;
    this.rawCall('Runtime.evaluate', {
      expression: `if(!document.title.startsWith('${MARKER}'))document.title='${MARKER} '+document.title`,
    }, sid, 2000).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onEvent(ev: CdpEvent): void {
    if (this.buf.length >= BUF_MAX) this.buf.shift();
    this.buf.push(ev);

    if (ev.method === 'Page.javascriptDialogOpening') {
      this.dialog = { type: ev.params?.type ?? '', message: ev.params?.message ?? '', url: ev.params?.url ?? '' };
    } else if (ev.method === 'Page.javascriptDialogClosed') {
      this.dialog = null;
    } else if ((ev.method === 'Page.loadEventFired' || ev.method === 'Page.domContentEventFired')
      && ev.sessionId === this.session.getActiveSession()) {
      // Navigation resets document.title — the marker must be re-stamped.
      this.stampMarker();
    }
  }

  // -------------------------------------------------------------------------
  // Host implementation
  // -------------------------------------------------------------------------

  get host(): Host {
    return {
      cdp: (method, params, opts) => this.cdp(method, params, opts),
      drainEvents: async () => { const out = this.buf; this.buf = []; return out; },
      activeSessionId: async () => this.session.getActiveSession(),
      activeTargetId: async () => this.attachedTargetId,
      setSession: async (sessionId, targetId) => {
        if (!sessionId || !targetId) { this.session.setActiveSession(undefined); return; }
        await this.adoptSession(sessionId, targetId);
      },
      currentTabInfo: async () => {
        if (!this.attachedTargetId) return null;
        try {
          // Browser-level: Target.* must never carry the page sessionId.
          const r = await this.rawBrowserCall('Target.getTargetInfo', { targetId: this.attachedTargetId }) as { targetInfo?: { targetId: string; url: string; title: string } };
          const info = r.targetInfo;
          if (!info) return null;
          const title = info.title.startsWith(MARKER_PREFIX) ? info.title.slice(3) : info.title;
          return { targetId: info.targetId, url: info.url, title };
        } catch {
          return null;
        }
      },
      pendingDialog: async () => this.dialog,
      tmpDir: () => bhTmpDir(),
      workspaceDir: () => workspaceDir(),
      screenshotTimeoutMs: () => envNumber('BH_SCREENSHOT_TIMEOUT', 60),
    };
  }

  /** Session call WITHOUT heal (raw). */
  private rawCall(method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<any> {
    return this.dispatchRaw(method, params, sessionId, timeoutMs ?? envNumber('BH_IPC_TIMEOUT', 5) * 1000);
  }

  /** Browser-level call (no sessionId ever). */
  private rawBrowserCall(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    return this.dispatchRaw(method, params, undefined, timeoutMs ?? envNumber('BH_IPC_TIMEOUT', 5) * 1000);
  }

  /**
   * Route through Session._call. For an explicit sessionId we swap the active
   * session around the synchronous send (build+send happen with no await, so
   * the swap-restore window is atomic in the event loop — no interleaving).
   */
  private dispatchRaw(method: string, params: Record<string, unknown>, explicitSid: string | undefined, budgetMs: number): Promise<any> {
    const browserLevel = method.startsWith('Browser.') || method.startsWith('Target.') || method.startsWith('Extensions.');
    if (browserLevel || !explicitSid) {
      return this.withTimeout((this.session as any)._call(method, params), budgetMs);
    }
    const saved = this.session.getActiveSession();
    this.session.setActiveSession(explicitSid);
    const p: Promise<any> = (this.session as any)._call(method, params);
    this.session.setActiveSession(saved);
    return this.withTimeout(p, budgetMs);
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${'CDP call'} timed out after ${Math.round(ms / 1000)}s waiting for the daemon`)), ms);
      p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
  }

  /**
   * Healed CDP round trip. Explicit sessionIds are never silently redirected;
   * implicit calls to a dead session re-attach the last target and retry once.
   */
  async cdp(method: string, params: Record<string, unknown> = {}, opts: { sessionId?: string; timeoutMs?: number } = {}): Promise<any> {
    const budget = opts.timeoutMs ?? envNumber('BH_IPC_TIMEOUT', 5) * 1000;
    try {
      return await this.dispatchRaw(method, params, opts.sessionId, budget);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/session with given id not found/i.test(msg) || opts.sessionId) throw e;
      // Self-heal: re-attach the last target, remember the replacement, retry once.
      if (this.replacements.length >= 32) throw new Error('too many session replacements (>=32) — the page is churning targets');
      const old = this.session.getActiveSession();
      let newSid: string;
      try {
        if (!this.attachedTargetId) throw e;
        newSid = await this.attachTo(this.attachedTargetId);
      } catch {
        // The last target itself is gone (closed/invalidated) — pick a fresh page.
        const fresh = await this.attachFirstPage();
        newSid = fresh.sessionId;
      }
      if (old) this.replacements.push({ from: old, to: newSid, at: Date.now() });
      return await this.dispatchRaw(method, params, newSid, budget);
    }
  }

  // -------------------------------------------------------------------------
  // Idle watchdog
  // -------------------------------------------------------------------------

  touch(): void { this.lastUsedAt = Date.now(); }

  /** Self-heal chain length (doctor diagnostics). */
  replacementCount(): number { return this.replacements.length; }

  startWatchdog(): void {
    const timeout = envNumber('BH_IDLE_TIMEOUT', 1800) * 1000;
    if (timeout <= 0) return;
    const interval = clamp(timeout / 4, 1_000, 30_000);
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastUsedAt < timeout) return;
      void this.idleExit();
    }, interval);
    this.watchdogTimer.unref?.();
  }

  private async idleExit(): Promise<void> {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    try {
      if (process.env.BH_ISOLATED_TASK === '1') {
        await stopAgentChrome();
      } else {
        // Only the last live daemon may take the browser down.
        const others = [DEFAULT_NAME, 'x-monitor'];
        let anyoneElse = false;
        for (const n of others) {
          if (n === instanceName()) continue;
          const rec = readInstanceRecord(n);
          if (!rec) continue;
          try {
            const res = await fetch(`http://127.0.0.1:${rec.port}/health`, { signal: AbortSignal.timeout(800) });
            if (res.ok) { anyoneElse = true; break; }
          } catch { /* down */ }
        }
        if (!anyoneElse) await stopAgentChrome();
      }
    } finally {
      this.session.close();
      process.exit(0);
    }
  }

  // -------------------------------------------------------------------------
  // Remote dispatch (remoteHost transport)
  // -------------------------------------------------------------------------

  async __bh_meta(op: string, payload: any): Promise<unknown> {
    switch (op) {
      case 'cdp': return this.cdp(payload.method, payload.params ?? {}, payload.opts ?? {});
      case 'drain': return await this.host.drainEvents();
      case 'set_session': return this.host.setSession(payload.sessionId, payload.targetId);
      case 'current_tab': return this.host.currentTabInfo();
      case 'pending_dialog': return await this.host.pendingDialog();
      case 'close_browser': {
        const ok = await stopAgentChrome();
        return { ok };
      }
      case 'session': {
        return { sessionId: this.session.getActiveSession() ?? null, targetId: this.attachedTargetId ?? null };
      }
      case 'ping': {
        return { ok: true, name: instanceName(), pid: process.pid, headless: await agentChromeHeadless() };
      }
      default:
        throw new Error(`bh: unknown __bh_meta op "${op}"`);
    }
  }
}
