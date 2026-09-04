/**
 * remoteHost — the Host implementation for one-shot CLI/plugin/worker
 * processes. Every call crosses as a normal JS literal over POST /eval
 * (`return await __bh_meta(op, payload)`); no new endpoint, no new protocol.
 */

import type { CdpEvent, Host } from './host.js';
import { tmpDir, workspaceDir } from './paths.js';
import { envNumber } from './env.js';

async function meta<T>(port: number, op: string, payload: unknown, timeoutMs?: number): Promise<T> {
  const code = `return await __bh_meta(${JSON.stringify(op)}, ${JSON.stringify(payload)})`;
  const res = await fetch(`http://127.0.0.1:${port}/eval`, {
    method: 'POST', body: code,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(body.trim().split('\n')[0] ?? `remote ${op} failed (${res.status})`);
  try { return JSON.parse(body) as T; } catch { return body as unknown as T; }
}

export function remoteHost(port: number): Host {
  return {
    async cdp(method, params = {}, opts = {}) {
      return meta<any>(port, 'cdp', {
        method, params, opts,
      }, (opts.timeoutMs ?? envNumber('BH_IPC_TIMEOUT', 5) * 1000) + 2_000);
    },
    async drainEvents() {
      return await meta<CdpEvent[]>(port, 'drain', {});
    },
    async activeSessionId() {
      const r = await meta<{ sessionId: string | null }>(port, 'session', {});
      return r.sessionId ?? undefined;
    },
    async activeTargetId() {
      const r = await meta<{ targetId: string | null }>(port, 'session', {});
      return r.targetId ?? undefined;
    },
    async setSession(sessionId, targetId) {
      await meta(port, 'set_session', { sessionId, targetId });
    },
    async currentTabInfo() {
      return await meta<{ targetId: string; url: string; title: string } | null>(port, 'current_tab', {});
    },
    async pendingDialog() {
      return await meta<{ type: string; message: string; url: string } | null>(port, 'pending_dialog', {});
    },
    tmpDir: () => tmpDir(),
    workspaceDir: () => workspaceDir(),
    screenshotTimeoutMs: () => envNumber('BH_SCREENSHOT_TIMEOUT', 60),
  };
}
