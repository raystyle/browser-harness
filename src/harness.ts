/**
 * Harness — the daemon semantics, in-process. Wraps the thin Session
 * transport with everything the Python daemon carried: the event ring
 * buffer, dialog capture, the horse marker, stale-session self-heal,
 * dedicated-tab attach policy, default-domain enables and the idle watchdog.
 *
 * D11 attach model: we NEVER spawn a browser. The daemon attaches the
 * browser the USER opened (discovered via DevToolsActivePort files — the
 * chrome://inspect/#remote-debugging toggle channel) and works only in its
 * own dedicated tab. Closing the user's browser, or any tab but our own,
 * is out of bounds.
 */

import { tmpDir as bhTmpDir, workspaceDir, instanceName } from './paths.js';
import { MARKER, MARKER_PREFIX, type CdpEvent, type SeqEvent, type Host } from './host.js';
import { Session, detectBrowsers, getBrowserCandidates } from './session.js';
import { clamp, envNumber } from './env.js';

const BUF_MAX = 500;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Attach-empty guidance: the ONE instruction an agent needs to unblock the user. */
function attachGuidance(scanned: string): string {
  return [
    'No attachable browser found (scanned: ' + scanned + ').',
    'bh attaches the browser YOU open — it never starts one. To enable:',
    '  1. open your Chrome (144+) as usual,',
    '  2. visit chrome://inspect/#remote-debugging and enable "Allow remote debugging for this browser instance",',
    '  3. retry. On the first connection Chrome shows an "Allow remote debugging?" prompt — click Allow.',
  ].join('\n');
}

export class Harness {
  readonly session: Session;
  private buf: SeqEvent[] = [];
  private dialog: { type: string; message: string; url: string } | null = null;
  private attachedTargetId: string | undefined;
  private replacements: Array<{ from: string; to: string; at: number }> = [];
  private lastUsedAt = Date.now();
  private watchdogTimer: ReturnType<typeof setInterval> | undefined;

  constructor(session: Session) {
    this.session = session;
    // D11 hard rule, enforced at the transport level: bh never closes or
    // reshapes the user's browser, and only ever closes its OWN tabs. The
    // guard sits in Session._call so direct session.domains.* evals cannot
    // bypass it either.
    session.installCallGuard((method, params) => this.guardBrowserLifetime(method, params));
    session.onEvent((method, params, sessionId) => this.onEvent({ method, params, sessionId }));
    // Tab ownership rides the transport, mirroring the callGuard above: every
    // Target.createTarget reply — whichever path issued it — joins the
    // closeable set. (issue #1: --new-tab's raw session.domains call used to
    // bypass the dispatcher-level registration and its tab became uncloseable.)
    session.onCreateTarget = (tid) => { this.ownedTargets.add(tid); };
    // Browser-level death watch: a closed WS means the user's browser went
    // down — keep trying to re-attach (the toggle channel survives browser
    // restarts); each new WS connection re-prompts Allow, so the user must
    // be around. Failures are logged, never fatal to the daemon.
    this.wasConnected = false;
    const watcher = setInterval(() => {
      const now = session.isConnected();
      if (this.wasConnected && !now) void this.reconnect();
      this.wasConnected = now;
    }, 5_000);
    watcher.unref?.();
  }

  private wasConnected: boolean;

  /**
   * Connect backoff: every WS attempt pops a fresh "Allow" prompt in Chrome
   * (per-connection permission), so retries must be polite — 30s doubling to
   * a 10min cap, reset on success. Without this a pending prompt plus a
   * 15s retry loop machine-guns the user with dialogs.
   */
  private backoff = { fails: 0, nextAt: 0 };

  /** Tabs bh may close: created by this daemon, or carrying the horse marker. */
  private ownedTargets = new Set<string>();

  /** Target discovery is per browser-level connection; re-armed on every connect(). */
  private discoveryOn = false;

  private guardBrowserLifetime(method: string, params: any): void {
    if (method === 'Browser.close') {
      throw new Error('blocked: Browser.close — the attached browser is the user\'s; bh never closes it. Close it yourself in the browser if you want it gone.');
    }
    if (method === 'Browser.setWindowBounds') {
      throw new Error('blocked: Browser.setWindowBounds — bh never reshapes the user\'s browser windows.');
    }
    if (method === 'Target.closeTarget') {
      const tid = String(params?.targetId ?? '');
      if (!this.ownedTargets.has(tid)) {
        throw new Error(`blocked: Target.closeTarget on ${tid || '(no targetId)'} — not a bh-owned tab (created or marked by bh). Close user tabs yourself in the browser.`);
      }
    }
  }

  connectPermitted(): boolean { return Date.now() >= this.backoff.nextAt; }
  noteConnectFailure(): void {
    const wait = Math.min(30_000 * 2 ** this.backoff.fails, 600_000);
    this.backoff.fails++;
    this.backoff.nextAt = Date.now() + wait;
  }
  noteConnectSuccess(): void { this.backoff = { fails: 0, nextAt: 0 }; }

  private async reconnect(): Promise<void> {
    if (!this.connectPermitted()) return; // backoff decides, not a fixed rate
    try {
      await this.connect();
      this.noteConnectSuccess();
    } catch (e: any) {
      this.noteConnectFailure();
      console.error(`bh: reconnect failed (next attempt in <=${Math.round((this.backoff.nextAt - Date.now()) / 1000)}s): ${String(e?.message ?? e)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Connection + attach
  // -------------------------------------------------------------------------

  /**
   * Resolve and connect: BH_CDP_WS direct → BH_CDP_URL poll /json/version
   * (30s; 403 = permission-blocked) → discover the user's browser via
   * DevToolsActivePort files and attach (30s per candidate — the first
   * connection waits on the Chrome "Allow" prompt). No spawn path exists.
   */
  async connect(): Promise<void> {
    this.discoveryOn = false; // fresh browser-level WS: discovery must be (re-)enabled
    const wsEnv = process.env.BH_CDP_WS;
    if (wsEnv) {
      await this.session.connect({ wsUrl: wsEnv, timeoutMs: 5_000 });
    } else if (process.env.BH_CDP_URL) {
      const ws = await this.pollCdpUrl(process.env.BH_CDP_URL, 30_000);
      await this.session.connect({ wsUrl: ws, timeoutMs: 5_000 });
    } else {
      const browsers = await detectBrowsers();
      if (browsers.length === 0) {
        throw new Error(attachGuidance(getBrowserCandidates().map(c => c.name).join(', ')));
      }
      const errors: string[] = [];
      for (const b of browsers) {
        try {
          await this.session.connect({ wsUrl: b.wsUrl, timeoutMs: 30_000 });
          if (this.shouldAttachEagerly()) await this.attachFirstPage();
          return;
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          errors.push(`  ${b.name} @ ${b.wsUrl}: ${msg}`);
        }
      }
      throw new Error(
        `No discovered browser accepted a connection. If one of these is yours, click "Allow" on its remote-debugging prompt and retry:\n${errors.join('\n')}`);
    }
    if (this.shouldAttachEagerly()) await this.attachFirstPage();
  }

  /** Named app daemons pin their surface eagerly; the default instance stays lazy. */
  private shouldAttachEagerly(): boolean {
    return !!process.env.BH_ATTACH_URL_MATCH;
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
        if (String(e?.message ?? e).startsWith('permission-blocked')) throw e;
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

  /** The web board is a read-only control plane — never an agent work surface. */
  private isControlPlane(url: string): boolean {
    const port = process.env.BH_DASHBOARD_PORT ?? '9870';
    return url.startsWith(`http://127.0.0.1:${port}`) || url.startsWith(`http://localhost:${port}`);
  }

  /**
   * Dedicated-tab attach policy (D11 coexistence iron rule): the agent ONLY
   * ever works in its own tab — previously ours (marked), then any blank
   * orphan, then a fresh background tab. A page the human is reading is
   * never picked. Operating a user tab requires explicit authorization
   * (switch_tab / set_session from the caller).
   */
  async attachFirstPage(): Promise<{ sessionId: string; targetId: string }> {
    await this.enableTargetDiscovery();
    const { targetInfos } = await this.rawBrowserCall('Target.getTargets', {}) as { targetInfos: Array<{ targetId: string; type: string; url: string; title: string }> };
    const pages = targetInfos.filter(t => t.type === 'page' && !this.isControlPlane(t.url));

    // App daemons pin their working surface: BH_ATTACH_URL_MATCH (substring)
    // prefers an EXISTING page over creating a dedicated blank — in the
    // attach model every new tab is visible clutter in the user's browser.
    // Preference order after that: blank > marked > create. Marked tabs often
    // belong to ANOTHER app daemon (x-intel marks x.com); the default instance
    // must never steal an app's working tab just because it carries the horse.
    const want = process.env.BH_ATTACH_URL_MATCH;
    let pick = (want && pages.find(t => t.url.includes(want))?.targetId)
      ?? pages.find(t => this.isReusableBlank(t.url))?.targetId
      ?? pages.find(t => (t.title ?? '').startsWith(MARKER))?.targetId;
    if (!pick) {
      const r = await this.rawBrowserCall('Target.createTarget', { url: 'about:blank', background: true }) as { targetId: string };
      pick = r.targetId;
    }
    this.ownedTargets.add(pick); // the working tab is ours to operate (and close when it's one we made)
    const sid = await this.attachTo(pick);
    return { sessionId: sid, targetId: pick };
  }

  /**
   * Target.targetInfoChanged only flows after Target.setDiscoverTargets —
   * without this call the marker-title ownership branch in onEvent is dead
   * code (issue #1). One call per browser-level connection, best-effort.
   */
  private async enableTargetDiscovery(): Promise<void> {
    if (this.discoveryOn) return;
    this.discoveryOn = true;
    await this.rawBrowserCall('Target.setDiscoverTargets', { discover: true }, 3_000).catch(() => {});
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

  private evtSeq = 0;

  private onEvent(ev: CdpEvent): void {
    if (this.buf.length >= BUF_MAX) this.buf.shift();
    this.buf.push({ ...ev, seq: ++this.evtSeq, t: Date.now() });

    // Single source of truth for the attached target: the BROWSER's attach
    // events. Anything that attaches a page (session.use, helpers'
    // switch_tab, remote set_session) emits Target.attachedToTarget —
    // tracking it here keeps attachedTargetId from going stale. Page-type
    // only: iframe attaches (js() isolation sessions) must not clobber it.
    if (ev.method === 'Target.attachedToTarget' && ev.params?.targetInfo?.type === 'page') {
      this.attachedTargetId = ev.params.targetInfo.targetId;
    } else if (ev.method === 'Target.detachedFromTarget'
      && String(ev.params?.targetId ?? '') === this.attachedTargetId) {
      // A transient probe detaches after scanning (page-detect watches every
      // tab). Clear the tracked target so the instance reports "not attached"
      // until the next implicit page-level call re-attaches lazily.
      this.attachedTargetId = undefined;
    } else if (ev.method === 'Target.targetInfoChanged'
      && String(ev.params?.targetInfo?.title ?? '').startsWith(MARKER)) {
      // A tab carrying the horse marker is ours by convention — closeable.
      this.ownedTargets.add(ev.params.targetInfo.targetId);
    } else if (ev.method === 'Page.javascriptDialogOpening') {
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
    let p: Promise<any>;
    if (browserLevel || !explicitSid) {
      p = (this.session as any)._call(method, params);
    } else {
      const saved = this.session.getActiveSession();
      this.session.setActiveSession(explicitSid);
      p = (this.session as any)._call(method, params);
      this.session.setActiveSession(saved);
    }
    // Target.createTarget ownership is registered in Session._call (transport
    // level) so raw session.domains evals register too — nothing to do here.
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
    const browserLevel = method.startsWith('Browser.') || method.startsWith('Target.') || method.startsWith('Extensions.');
    if (!browserLevel && !opts.sessionId && !this.session.getActiveSession()) {
      await this.attachFirstPage();
    }
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

  /**
   * Idle exit closes OUR session only. The browser belongs to the user —
   * an idle daemon must never take it (or any tab) down.
   */
  private async idleExit(): Promise<void> {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.session.close();
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Remote dispatch (remoteHost transport)
  // -------------------------------------------------------------------------

  async __bh_meta(op: string, payload: any): Promise<unknown> {
    switch (op) {
      case 'cdp': return this.cdp(payload.method, payload.params ?? {}, payload.opts ?? {});
      case 'drain': return await this.host.drainEvents();
      case 'peek': {
        // Non-destructive read (dashboards). Optional method filter scans the
        // WHOLE ring so interesting events survive Network-event floods.
        const limit = Math.min(Number(payload?.limit ?? 50), 100);
        const flt: string[] = Array.isArray(payload?.filter) ? payload.filter : [];
        const src = flt.length
          ? this.buf.filter(e => flt.some(f => e.method === f || e.method.startsWith(f + '.')))
          : this.buf;
        return src.slice(-limit);
      }
      case 'set_session': return this.host.setSession(payload.sessionId, payload.targetId);
      case 'current_tab': return this.host.currentTabInfo();
      case 'pending_dialog': return await this.host.pendingDialog();
      case 'session': {
        return { sessionId: this.session.getActiveSession() ?? null, targetId: this.attachedTargetId ?? null };
      }
      case 'ping': {
        return { ok: true, name: instanceName(), pid: process.pid };
      }
      default:
        throw new Error(`bh: unknown __bh_meta op "${op}"`);
    }
  }
}
