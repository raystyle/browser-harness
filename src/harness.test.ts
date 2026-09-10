import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Harness } from './harness.js';
import { Session } from './session.js';
import { MARKER_PREFIX } from './host.js';

/**
 * Session with a fake WebSocket: every send is dispatched through a
 * per-method handler (method -> params -> result | throw); replies are
 * delivered on a microtask. Incoming events can be injected with emit().
 */
function harnessWith(handlers: Record<string, (p: any) => any> = {}) {
  const session = new Session();
  const sent: any[] = [];
  (session as any).ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const m = JSON.parse(raw);
      sent.push(m);
      queueMicrotask(() => {
        const h = handlers[m.method];
        if (!h) { (session as any).onMessage(JSON.stringify({ id: m.id, result: {} })); return; }
        let result: unknown, error: { code: number; message: string } | undefined;
        try { result = h(m.params); }
        catch (e: any) { error = { code: -32000, message: String(e?.message ?? e) }; }
        (session as any).onMessage(JSON.stringify(error ? { id: m.id, error } : { id: m.id, result }));
      });
    },
  };
  const harness = new Harness(session);
  const emit = (method: string, params: unknown, sessionId?: string) =>
    (session as any).onMessage(JSON.stringify(sessionId ? { method, params, sessionId } : { method, params }));
  return { harness, session, sent, emit };
}

describe('event ring buffer', () => {
  test('caps at 500 and keeps the newest tail', async () => {
    const { harness, emit } = harnessWith();
    for (let i = 0; i < 501; i++) emit('X.tick', { i });
    const drained = await harness.host.drainEvents();
    assert.equal(drained.length, 500);
    assert.equal(drained[0]!.params.i, 1);   // oldest dropped
    assert.equal(drained[499]!.params.i, 500);
    // draining clears
    assert.deepEqual(await harness.host.drainEvents(), []);
  });
});

describe('dialog capture', () => {
  test('javascriptDialogOpening is captured; javascriptDialogClosed clears it', async () => {
    const { harness, emit } = harnessWith();
    assert.equal(await harness.host.pendingDialog(), null);
    emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi', url: 'https://x/' });
    assert.deepEqual(await harness.host.pendingDialog(), { type: 'alert', message: 'hi', url: 'https://x/' });
    emit('Page.javascriptDialogClosed', {});
    assert.equal(await harness.host.pendingDialog(), null);
  });
});

describe('attached-target tracking (browser events as source of truth)', () => {
  test('Target.attachedToTarget (page) keeps attachedTargetId in sync with a bare session.use()', async () => {
    const { harness, session, emit } = harnessWith({
      'Target.attachToTarget': () => ({ sessionId: 's-via-use' }),
      'Target.getTargetInfo': (p: any) => ({ targetInfo: { targetId: p.targetId, url: 'https://tracked.example/', title: 'Tracked' } }),
    });
    // A caller attaches via the thin SDK — only the Session would know.
    await session.use('T9');
    // The browser then notifies every listener:
    emit('Target.attachedToTarget', { sessionId: 's-via-use', targetInfo: { targetId: 'T9', type: 'page' } });
    const info = await harness.host.currentTabInfo();
    assert.equal(info?.targetId, 'T9');
    assert.equal(info?.url, 'https://tracked.example/');
  });

  test('session.use AFTER an adoption still moves the tracked surface (B1: no split brain)', async () => {
    const { harness, session, emit } = harnessWith({
      'Target.attachToTarget': () => ({ sessionId: 's-use2' }),
      'Target.getTargetInfo': (p: any) => ({ targetInfo: { targetId: p.targetId, type: 'page', url: 'https://u.example/', title: '' } }),
    });
    // An adoption already holds TAPP (daemon-level attach / implicit lazy adopt).
    await harness.host.setSession('s-adopted', 'TAPP');
    emit('Target.attachedToTarget', { sessionId: 's-adopted', targetInfo: { targetId: 'TAPP', type: 'page' } });
    // The documented protocol-layer switch (skill tabs.md / bh --new-tab).
    // The onUse commit is async (page-type verified via getTargetInfo) — settle it.
    await session.use('TOTHER');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(await harness.host.activeSessionId(), 's-use2');
    assert.equal((await harness.host.currentTabInfo())?.targetId, 'TOTHER');
    // The use-lane session is now the adoption: its own teardown clears.
    emit('Target.detachedFromTarget', { sessionId: 's-use2' });
    assert.equal(await harness.host.currentTabInfo(), null);
  });

  test('an iframe-scoped session.use never hijacks the tracked surface (page-only invariant)', async () => {
    const { harness, session, emit } = harnessWith({
      'Target.attachToTarget': () => ({ sessionId: 's-iframe' }),
      'Target.getTargetInfo': (p: any) => ({ targetInfo: { targetId: p.targetId, type: p.targetId === 'TIF' ? 'iframe' : 'page', url: 'https://i.example/', title: '' } }),
    });
    await harness.host.setSession('s-adopted', 'TPAGE');
    emit('Target.attachedToTarget', { sessionId: 's-adopted', targetInfo: { targetId: 'TPAGE', type: 'page' } });
    // cross-origin-iframes.md's documented pattern: iframe-scoped work.
    await session.use('TIF');
    emit('Target.attachedToTarget', { sessionId: 's-iframe', targetInfo: { targetId: 'TIF', type: 'iframe' } });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(await harness.host.activeSessionId(), 's-iframe'); // the CALLER's scope moved
    assert.equal((await harness.host.currentTabInfo())?.targetId, 'TPAGE'); // the tracked page did not
    // The iframe session's teardown is not the page adoption: nothing clears.
    emit('Target.detachedFromTarget', { sessionId: 's-iframe' });
    assert.equal((await harness.host.currentTabInfo())?.targetId, 'TPAGE');
  });

  test('iframe attaches never clobber the tracked page target', async () => {
    const { harness, emit } = harnessWith({
      'Target.getTargetInfo': (p: any) => ({ targetInfo: { targetId: p.targetId, url: 'https://page.example/', title: '' } }),
    });
    emit('Target.attachedToTarget', { sessionId: 's1', targetInfo: { targetId: 'TPAGE', type: 'page' } });
    emit('Target.attachedToTarget', { sessionId: 's2', targetInfo: { targetId: 'TIF', type: 'iframe' } });
    const info = await harness.host.currentTabInfo();
    assert.equal(info?.targetId, 'TPAGE');
  });

  test('detach without the deprecated optional targetId still clears the tracked target', async () => {
    const { harness, emit } = harnessWith({
      'Target.getTargetInfo': (p: any) => ({ targetInfo: { targetId: p.targetId, url: 'https://tracked.example/', title: 'Tracked' } }),
    });
    emit('Target.attachedToTarget', { sessionId: 's1', targetInfo: { targetId: 'T9', type: 'page' } });
    assert.equal((await harness.host.currentTabInfo())?.targetId, 'T9');
    // Chrome may omit the deprecated targetId — sessionId is the only
    // guaranteed field. Missing it used to strand a stale attach forever
    // (page-detect probes every tab, so the stale target was the last probed).
    emit('Target.detachedFromTarget', { sessionId: 's1' });
    assert.equal(await harness.host.currentTabInfo(), null);
  });

  test('detach discriminates by session: an unrelated session\'s detach never clears', async () => {
    const { harness, emit } = harnessWith({
      'Target.getTargetInfo': (p: any) => ({ targetInfo: { targetId: p.targetId, url: 'https://p.example/', title: '' } }),
    });
    emit('Target.attachedToTarget', { sessionId: 's-work', targetInfo: { targetId: 'TWORK', type: 'page' } });
    emit('Target.attachedToTarget', { sessionId: 's-probe', targetInfo: { targetId: 'TPROBE', type: 'page' } });
    // last page attach wins the tracked slot: TPROBE
    emit('Target.detachedFromTarget', { sessionId: 's-work' }); // TWORK ≠ tracked
    assert.equal((await harness.host.currentTabInfo())?.targetId, 'TPROBE');
    emit('Target.detachedFromTarget', { sessionId: 's-probe' }); // the tracked one
    assert.equal(await harness.host.currentTabInfo(), null);
  });

  test('a transient probe on the adopted target never clears it (D40 pinned-eval pattern)', async () => {
    const { harness, emit } = harnessWith({
      'Target.getTargetInfo': (p: any) => ({ targetInfo: { targetId: p.targetId, url: 'https://x.com/home', title: '' } }),
    });
    // Daemon-level adoption (attachFirstPage / switch_tab / set_session all
    // funnel into adoptSession), plus the attach event Chrome really emits.
    await harness.host.setSession('s-adopted', 'TAPP');
    emit('Target.attachedToTarget', { sessionId: 's-adopted', targetInfo: { targetId: 'TAPP', type: 'page' } });
    // The monitor lane's probe: js(expr, TAPP) = fresh attach -> eval -> detach,
    // on the SAME target the daemon adopted. Before the fix this cleared the
    // tracked target after every 6-8s tick (dashboard showed 已脱离 while
    // the daemon held a live session).
    emit('Target.attachedToTarget', { sessionId: 's-probe', targetInfo: { targetId: 'TAPP', type: 'page' } });
    emit('Target.detachedFromTarget', { sessionId: 's-probe' });
    assert.equal((await harness.host.currentTabInfo())?.targetId, 'TAPP');
    // A probe on a DIFFERENT page must not hijack the adopted surface either.
    emit('Target.attachedToTarget', { sessionId: 's-probe2', targetInfo: { targetId: 'TOTHER', type: 'page' } });
    emit('Target.detachedFromTarget', { sessionId: 's-probe2' });
    assert.equal((await harness.host.currentTabInfo())?.targetId, 'TAPP');
    // The adopted session's own teardown (tab closed) is the one real detach.
    emit('Target.detachedFromTarget', { sessionId: 's-adopted' });
    assert.equal(await harness.host.currentTabInfo(), null);
  });
});

describe('marker discipline', () => {  test('navigation on the active session re-stamps the horse marker', async () => {
    const { harness, session, emit, sent } = harnessWith();
    session.setActiveSession('s1');
    emit('Page.loadEventFired', {}, 's1');
    await new Promise(r => setTimeout(r, 20)); // stampMarker fires async (.catch(() => {}))
    const stamps = sent.filter(m => m.method === 'Runtime.evaluate' && /document\.title/.test(m.params.expression));
    assert.ok(stamps.length >= 1, 'marker re-stamped after load');
    // navigation on ANOTHER session must not stamp
    const before = sent.length;
    emit('Page.loadEventFired', {}, 's-other');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(sent.length, before);
  });
});

describe('browser-lifetime guard (D11 hard rule, enforced in Session._call)', () => {
  test('Browser.close and Browser.setWindowBounds are blocked outright', async () => {
    const { harness } = harnessWith();
    await assert.rejects(harness.cdp('Browser.close', {}), /blocked: Browser\.close/);
    await assert.rejects(harness.cdp('Browser.setWindowBounds', { windowId: 1, bounds: {} }), /blocked: Browser\.setWindowBounds/);
  });

  test('Target.closeTarget: a tab bh created is closeable, a foreign tab is not', async () => {
    const { harness } = harnessWith({ 'Target.createTarget': () => ({ targetId: 'TMINE' }) });
    const r = await harness.cdp('Target.createTarget', { url: 'about:blank', background: true });
    assert.equal(r.targetId, 'TMINE');
    await harness.cdp('Target.closeTarget', { targetId: 'TMINE' }); // own tab: passes
    await assert.rejects(
      harness.cdp('Target.closeTarget', { targetId: 'TUSER' }),
      /blocked: Target\.closeTarget on TUSER/,
    );
  });

  test('direct session.domains.* calls cannot bypass the guard', async () => {
    const { session } = harnessWith();
    // The guard throws synchronously inside _call; wrap so rejects() sees it.
    await assert.rejects(async () => session.domains.Browser.close(), /blocked: Browser\.close/);
    await assert.rejects(async () => session.domains.Target.closeTarget({ targetId: 'TUSER' }), /blocked: Target\.closeTarget/);
  });

  test('a tab carrying the horse marker joins the closeable set', async () => {
    const { harness, emit } = harnessWith();
    emit('Target.targetInfoChanged', { targetInfo: { targetId: 'TMARKED', type: 'page', title: '🐴 Marked' } });
    await harness.cdp('Target.closeTarget', { targetId: 'TMARKED' }); // passes silently
  });
});

describe('dedicated-tab attach policy (D11 coexistence iron rule)', () => {
  function withPages(pages: Array<{ targetId: string; url: string; title?: string }>) {
    return harnessWith({
      'Target.getTargets': () => ({ targetInfos: pages.map(p => ({ type: 'page', ...p })) }),
      'Target.createTarget': () => ({ targetId: 'TFRESH' }),
      'Target.attachToTarget': () => ({ sessionId: 's-dedicated' }),
    });
  }

  test('BH_ATTACH_URL_MATCH pins the app daemon to the EXISTING page (no new tab)', async () => {
    const { harness, sent } = withPages([
      { targetId: 'TAPP', url: 'https://x.com/home', title: '(1) 主页 / X' },
      { targetId: 'TBLANK', url: 'about:blank', title: '' },
    ]);
    const saved = process.env.BH_ATTACH_URL_MATCH;
    process.env.BH_ATTACH_URL_MATCH = 'x.com';
    try {
      const r = await (harness as any).attachFirstPage();
      assert.equal(r.targetId, 'TAPP'); // the user's existing x.com tab, not the blank
      assert.equal(sent.some(m => m.method === 'Target.createTarget'), false);
    } finally {
      if (saved === undefined) delete process.env.BH_ATTACH_URL_MATCH;
      else process.env.BH_ATTACH_URL_MATCH = saved;
    }
  });

  test('NEVER picks a page the human is reading — prefers a blank orphan', async () => {
    const { harness, sent } = withPages([
      { targetId: 'TUSER', url: 'https://user-is-reading.example/', title: 'User Page' },
      { targetId: 'TBLANK', url: 'about:blank', title: '' },
    ]);
    const r = await (harness as any).attachFirstPage();
    assert.equal(r.targetId, 'TBLANK');
    assert.equal(sent.some(m => m.method === 'Target.createTarget'), false);
  });

  test('no reusable tab -> creates a fresh BACKGROUND tab, never steals the user page', async () => {
    const { harness, sent } = withPages([
      { targetId: 'TUSER', url: 'https://user-is-reading.example/', title: 'User Page' },
    ]);
    const r = await (harness as any).attachFirstPage();
    assert.equal(r.targetId, 'TFRESH');
    const create = sent.find(m => m.method === 'Target.createTarget');
    assert.deepEqual(create!.params, { url: 'about:blank', background: true });
  });

  test('never attaches to the dashboard control plane — prefers blank, else creates', async () => {
    const { harness, sent } = withPages([
      { targetId: 'TDASH', url: 'http://127.0.0.1:9870/', title: 'bh 看板' },
      { targetId: 'TUSER', url: 'https://user-is-reading.example/', title: 'User Page' },
      { targetId: 'TBLANK', url: 'about:blank', title: '' },
    ]);
    const r = await (harness as any).attachFirstPage();
    assert.equal(r.targetId, 'TBLANK');
    assert.equal(sent.some(m => m.method === 'Target.createTarget'), false);
  });

  test('dashboard-only browser still does not steal it — creates a background blank', async () => {
    const { harness, sent } = withPages([
      { targetId: 'TDASH', url: 'http://127.0.0.1:9870/', title: 'bh 看板' },
    ]);
    const r = await (harness as any).attachFirstPage();
    assert.equal(r.targetId, 'TFRESH');
    const create = sent.find(m => m.method === 'Target.createTarget');
    assert.deepEqual(create!.params, { url: 'about:blank', background: true });
  });

  test('blank beats marked: the default instance never steals an app daemon\'s working tab', async () => {
    const { harness, sent } = withPages([
      { targetId: 'TUSER', url: 'https://user-is-reading.example/', title: 'User Page' },
      { targetId: 'TBLANK', url: 'about:blank', title: '' },
      { targetId: 'TOURS', url: 'https://ours.example/', title: '🐴 Ours' },
    ]);
    const r = await (harness as any).attachFirstPage();
    assert.equal(r.targetId, 'TBLANK'); // blank first; marked tabs may belong to another app
    assert.equal(sent.some(m => m.method === 'Target.createTarget'), false);
  });

  test('closeTarget reclaims a horse-marked tab without attachFirstPage (issue #1 restart)', async () => {
    const { harness } = harnessWith({
      'Target.getTargetInfo': (p: any) => ({
        targetInfo: { targetId: p.targetId, title: p.targetId === 'TMARK' ? MARKER_PREFIX + 'Example' : 'News' },
      }),
    });
    await harness.cdp('Target.closeTarget', { targetId: 'TMARK' });
    await assert.rejects(
      harness.cdp('Target.closeTarget', { targetId: 'TUSER' }),
      /blocked: Target\.closeTarget on TUSER/,
    );
  });

  test('attachFirstPage reclaims horse-marked tabs into ownedTargets (issue #1 restart)', async () => {
    const { harness } = withPages([
      { targetId: 'TMARK', url: 'https://example.com/', title: MARKER_PREFIX + 'Example' },
      { targetId: 'TUSER', url: 'https://news.example/', title: 'News' },
    ]);
    await (harness as any).attachFirstPage();
    await harness.cdp('Target.closeTarget', { targetId: 'TMARK' });
    await assert.rejects(
      harness.cdp('Target.closeTarget', { targetId: 'TUSER' }),
      /blocked: Target\.closeTarget on TUSER/,
    );
  });
});

describe('stale-session self-heal', () => {
  test('"session with given id not found" re-attaches the target and retries once', async () => {
    let navigateAttempts = 0;
    const { harness, session, sent } = harnessWith({
      'Page.navigate': () => {
        navigateAttempts++;
        if (navigateAttempts === 1) throw new Error('Session with given id not found');
        return { frameId: 'f1', url: 'https://healed/' };
      },
      'Target.getTargets': () => ({ targetInfos: [{ targetId: 'T1', type: 'page', url: 'about:blank', title: '' }] }),
      'Target.attachToTarget': () => ({ sessionId: 's-fresh' }),
      'Target.getTargetInfo': () => ({ targetInfo: { targetId: 'T1', url: 'about:blank', title: '' } }),
    });
    session.setActiveSession('s-stale');
    // Give the heal path a target to re-attach without disturbing the stale active session.
    (harness as any).attachedTargetId = 'T1';

    const r = await harness.cdp('Page.navigate', { url: 'https://healed/' });
    assert.deepEqual(r, { frameId: 'f1', url: 'https://healed/' });
    assert.equal(navigateAttempts, 2);
    assert.equal(harness.replacementCount(), 1);
    // the retry rode the fresh session, not the stale one
    const retries = sent.filter(m => m.method === 'Page.navigate');
    assert.equal(retries[0]!.sessionId, 's-stale');
    assert.equal(retries[1]!.sessionId, 's-fresh');
  });

  test('explicit sessionIds are never silently redirected', async () => {
    const { harness } = harnessWith({
      'Page.navigate': () => { throw new Error('Session with given id not found'); },
    });
    await assert.rejects(
      harness.cdp('Page.navigate', { url: 'https://x/' }, { sessionId: 's-explicit' }),
      /session with given id not found/i,
    );
    assert.equal(harness.replacementCount(), 0);
  });
});
