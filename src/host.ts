/**
 * Host — the transport-agnostic interface the semantic layer (helpers.ts)
 * programs against. Two implementations:
 *   - inProcessHost: the REPL server's Harness (direct function calls)
 *   - remoteHost (remote.ts): one-shot CLI/plugin processes over POST /eval
 *
 * helpers.ts must NEVER import harness.ts — a remote host would otherwise
 * drag the whole REPL process into the plugin's import graph.
 */

export type CdpEvent = { method: string; params: any; sessionId?: string };
/** Ring-buffer enrichment (invisible to drain consumers): monotonic seq + wall time,
 *  so dashboards can accumulate peeked events without collapsing duplicates. */
export type SeqEvent = CdpEvent & { seq: number; t: number };

export interface Host {
  /** One CDP round trip; carries stale-session self-heal and the default 5s budget. */
  cdp(method: string, params?: Record<string, unknown>,
      opts?: { sessionId?: string; timeoutMs?: number }): Promise<any>;

  /** Drain (and clear) the event ring buffer. */
  drainEvents(): Promise<CdpEvent[]>;

  /** Active sessionId — self-heal chain and network-idle filtering need it. */
  activeSessionId(): Promise<string | undefined>;

  /** Attached target id, when a page is attached. */
  activeTargetId(): Promise<string | undefined>;

  /** Re-attach: strip Network on the old session, enable 4 domains on the new, re-stamp the marker. */
  setSession(sessionId: string | undefined, targetId?: string): Promise<void>;

  /**
   * Info of the attached page. Target.getTargetInfo MUST be called
   * browser-level — a helper calling it itself would get it wrongly tagged
   * with the page sessionId.
   */
  currentTabInfo(): Promise<{ targetId: string; url: string; title: string } | null>;

  /** Currently captured dialog (Page.javascriptDialogOpening), if any. */
  pendingDialog(): Promise<{ type: string; message: string; url: string } | null>;

  /** Directories. */
  tmpDir(): string;
  workspaceDir(): string;

  /** Screenshot budget (default 60s — the normal 5s budget kills every capture). */
  screenshotTimeoutMs(): number;
}

/** Horse marker: U+1F434 is a surrogate pair (2 UTF-16 units) + space = 3. */
export const MARKER = '\u{1F434}';
export const MARKER_PREFIX = '\u{1F434} '; // length 3 in UTF-16 code units

/** The web board is a read-only control plane — never a work tab. */
export function dashboardPort(): string {
  return process.env.BH_DASHBOARD_PORT ?? '9870';
}

export function isDashboardUrl(url: string): boolean {
  const port = dashboardPort();
  let u: URL;
  try { u = new URL(String(url ?? '')); } catch { return false; }
  // Exact origin match: a startsWith on the origin string would also swallow
  // e.g. http://127.0.0.1:98700 — a LONGER port a local app may legitimately
  // occupy — and refuse it as if it were the control plane.
  return u.protocol === 'http:'
    && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')
    && u.port === port;
}

export function dashboardForbiddenMsg(): string {
  return `bh: 看板 http://127.0.0.1:${dashboardPort()} 不是工作 tab，default 与应用禁止附着；请在 Chrome 里自己打开看板`;
}
