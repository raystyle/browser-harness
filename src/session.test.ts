import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Session, CdpError, resolveWsUrl, detectBrowsers } from './session.js';

async function sentMessage(method: string): Promise<Record<string, unknown>> {
  const session = new Session();
  session.setActiveSession('page-session');

  let sent: Record<string, unknown> | undefined;
  (session as any).ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      sent = JSON.parse(raw);
      queueMicrotask(() => {
        (session as any).onMessage(JSON.stringify({ id: sent!.id, result: {} }));
      });
    },
  };

  await session._call(method, {});
  return sent!;
}

describe('Session CDP routing', () => {
  test('keeps page commands on the active target session', async () => {
    const msg = await sentMessage('Page.navigate');
    assert.equal(msg['sessionId'], 'page-session');
  });

  test('routes extension commands through the browser session', async () => {
    const msg = await sentMessage('Extensions.getExtensions');
    assert.equal('sessionId' in msg, false);
  });

  test('routes Browser.* and Target.* browser-level too', async () => {
    for (const m of ['Browser.getVersion', 'Target.getTargets']) {
      const msg = await sentMessage(m);
      assert.equal('sessionId' in msg, false, m);
    }
  });

  test('rejects CDP errors as CdpError with code and message', async () => {
    const session = new Session();
    (session as any).ws = {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        const m = JSON.parse(raw);
        queueMicrotask(() => {
          (session as any).onMessage(JSON.stringify({ id: m.id, error: { code: -32000, message: 'boom' } }));
        });
      },
    };
    await assert.rejects(session._call('Page.navigate', {}), (e: unknown) => {
      assert.ok(e instanceof CdpError);
      assert.equal(e.code, -32000);
      assert.match(e.message, /CDP -32000: boom/);
      return true;
    });
  });

  test('_call before connect rejects with a clear message', async () => {
    const session = new Session();
    await assert.rejects(session._call('Page.navigate', {}), /Not connected/);
  });
});

describe('Session events', () => {
  function fakeSession() {
    const session = new Session();
    const sent: any[] = [];
    (session as any).ws = {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        const m = JSON.parse(raw);
        sent.push(m);
        queueMicrotask(() => (session as any).onMessage(JSON.stringify({ id: m.id, result: {} })));
      },
    };
    return { session, sent };
  }

  test('onEvent listeners see method/params/sessionId; unsubscribe works', () => {
    const { session } = fakeSession();
    const seen: Array<[string, unknown, string | undefined]> = [];
    const unsub = session.onEvent((m, p, sid) => seen.push([m, p, sid]));
    (session as any).onMessage(JSON.stringify({ method: 'Page.loadEventFired', params: { a: 1 }, sessionId: 's9' }));
    unsub();
    (session as any).onMessage(JSON.stringify({ method: 'Page.loadEventFired', params: { a: 2 } }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]![0], 'Page.loadEventFired');
    assert.deepEqual(seen[0]![1], { a: 1 });
    assert.equal(seen[0]![2], 's9');
  });

  test('waitFor resolves on predicate match and times out otherwise', async () => {
    const { session } = fakeSession();
    const p = session.waitFor<{ n: number }>('X.tick', p => p.n === 2, 250);
    (session as any).onMessage(JSON.stringify({ method: 'X.tick', params: { n: 1 } }));
    (session as any).onMessage(JSON.stringify({ method: 'X.tick', params: { n: 2 } }));
    assert.equal((await p).n, 2);
    await assert.rejects(session.waitFor('X.never', undefined, 100), /Timeout waiting for X.never/);
  });
});

describe('resolveWsUrl', () => {
  test('{ wsUrl } is passthrough', async () => {
    assert.equal(await resolveWsUrl({ wsUrl: 'ws://h:1/x' }), 'ws://h:1/x');
  });

  test('{ profileDir } builds the URL straight from DevToolsActivePort (no HTTP probe)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bh-resolve-'));
    try {
      writeFileSync(path.join(dir, 'DevToolsActivePort'), '1234\n/devtools/browser/abc-uuid\n');
      assert.equal(await resolveWsUrl({ profileDir: dir }), 'ws://127.0.0.1:1234/devtools/browser/abc-uuid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('neither option rejects', async () => {
    await assert.rejects(resolveWsUrl({}), /wsUrl.*profileDir|profileDir.*wsUrl/);
  });
});

describe('detectBrowsers (DevToolsActivePort scan)', () => {
  // First candidate per platform, matching getBrowserCandidates()'s layout.
  function firstCandidate(): { env: string; root: () => string; rel: string } {
    if (process.platform === 'win32') {
      return { env: 'LOCALAPPDATA', root: () => process.env.LOCALAPPDATA ?? '', rel: path.join('Google', 'Chrome', 'User Data') };
    }
    if (process.platform === 'darwin') {
      return { env: 'HOME', root: () => process.env.HOME ?? '', rel: path.join('Library', 'Application Support', 'Google', 'Chrome') };
    }
    return { env: 'HOME', root: () => process.env.HOME ?? '', rel: path.join('.config', 'google-chrome') };
  }

  test('finds browsers with a live-looking file, orders by mtime desc, skips malformed', async () => {
    const { env, rel } = firstCandidate();
    const saved = process.env[env];
    const sandbox = mkdtempSync(path.join(tmpdir(), 'bh-detect-'));
    process.env[env] = sandbox;
    try {
      const older = path.join(sandbox, rel);
      mkdirSync(older, { recursive: true });
      writeFileSync(path.join(older, 'DevToolsActivePort'), '1111\n/devtools/browser/older\n');
      utimesSync(path.join(older, 'DevToolsActivePort'), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

      // A second Chromium-family profile: Brave (present in every platform's candidate list).
      const braveRel = process.platform === 'win32'
        ? path.join('BraveSoftware', 'Brave-Browser', 'User Data')
        : process.platform === 'darwin'
          ? path.join('Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')
          : path.join('.config', 'BraveSoftware', 'Brave-Browser');
      const newer = path.join(sandbox, braveRel);
      mkdirSync(newer, { recursive: true });
      writeFileSync(path.join(newer, 'DevToolsActivePort'), '2222\n/devtools/browser/newer\n');
      utimesSync(path.join(newer, 'DevToolsActivePort'), new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));

      // Malformed: bad port line -> skipped entirely.
      const chromiumRel = process.platform === 'win32'
        ? path.join('Chromium', 'User Data')
        : process.platform === 'darwin'
          ? path.join('Library', 'Application Support', 'Chromium')
          : path.join('.config', 'chromium');
      const malformed = path.join(sandbox, chromiumRel);
      mkdirSync(malformed, { recursive: true });
      writeFileSync(path.join(malformed, 'DevToolsActivePort'), 'not-a-port\n/devtools/browser/x\n');

      const found = await detectBrowsers();
      assert.equal(found.length, 2);
      assert.equal(found[0]!.port, 2222); // most recently launched first
      assert.equal(found[0]!.wsUrl, 'ws://127.0.0.1:2222/devtools/browser/newer');
      assert.equal(found[1]!.port, 1111);
    } finally {
      process.env[env] = saved;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('empty scan (no DevToolsActivePort anywhere) returns an empty list', async () => {
    const { env } = firstCandidate();
    const saved = process.env[env];
    const sandbox = mkdtempSync(path.join(tmpdir(), 'bh-empty-'));
    process.env[env] = sandbox;
    try {
      assert.deepEqual(await detectBrowsers(), []);
    } finally {
      process.env[env] = saved;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test('Microsoft Edge is never discovered, even with a live DevToolsActivePort (D11 directive)', async () => {
    const { env } = firstCandidate();
    const saved = process.env[env];
    const sandbox = mkdtempSync(path.join(tmpdir(), 'bh-edge-'));
    process.env[env] = sandbox;
    try {
      const edgeRel = process.platform === 'win32'
        ? path.join('Microsoft', 'Edge', 'User Data')
        : process.platform === 'darwin'
          ? path.join('Library', 'Application Support', 'Microsoft Edge')
          : path.join('.config', 'microsoft-edge');
      const edgeProfile = path.join(sandbox, edgeRel);
      mkdirSync(edgeProfile, { recursive: true });
      writeFileSync(path.join(edgeProfile, 'DevToolsActivePort'), '9222\n/devtools/browser/edge-uuid\n');
      assert.deepEqual(await detectBrowsers(), []);
    } finally {
      process.env[env] = saved;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
