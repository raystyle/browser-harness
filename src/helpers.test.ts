import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createHelpers } from './helpers.js';
import { MARKER_PREFIX, type Host } from './host.js';

type Call = { method: string; params: any; opts: any };

/**
 * Fake Host recording every cdp() call (method, params, opts). `respond` maps
 * method -> (params) -> result (or throw); anything unmapped returns {}.
 */
function fakeHost(respond: Record<string, (p: any) => any> = {}) {
  const calls: Call[] = [];
  let dialog: { type: string; message: string; url: string } | null = null;
  let tabInfo: { targetId: string; url: string; title: string } | null = { targetId: 't1', url: 'https://example.com/', title: 'Example' };
  const host: Host = {
    cdp: async (method, params = {}, opts = {}) => {
      calls.push({ method, params, opts });
      const h = respond[method];
      if (!h) return {};
      return h(params);
    },
    drainEvents: async () => [],
    activeSessionId: async () => 's1',
    activeTargetId: async () => 't1',
    setSession: async () => {},
    currentTabInfo: async () => tabInfo,
    pendingDialog: async () => dialog,
    tmpDir: () => '/tmp',
    workspaceDir: () => '/ws',
    screenshotTimeoutMs: () => 60,
  };
  return {
    host, calls,
    setDialog: (d: typeof dialog) => { dialog = d; },
    setTabInfo: (t: typeof tabInfo) => { tabInfo = t; },
  };
}

describe('press_key (physical-key truth)', () => {
  test("'a' sends keyDown + char + keyUp with code KeyA / vk 65", async () => {
    const { host, calls } = fakeHost();
    const h = createHelpers(host);
    await h.press_key('a');
    const kinds = calls.filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params.type);
    assert.deepEqual(kinds, ['keyDown', 'char', 'keyUp']);
    const down = calls.find(c => c.params.type === 'keyDown')!;
    assert.equal(down.params.code, 'KeyA');
    assert.equal(down.params.windowsVirtualKeyCode, 65);
    assert.equal(down.params.modifiers, 0);
    assert.equal(calls.find(c => c.params.type === 'char')!.params.text, 'a');
  });

  test("'A' adds the Shift modifier (bit 8)", async () => {
    const { host, calls } = fakeHost();
    await createHelpers(host).press_key('A');
    assert.equal(calls.find(c => c.params.type === 'keyDown')!.params.modifiers, 8);
  });

  test('Ctrl+a composes a shortcut: no char event, no Shift', async () => {
    const { host, calls } = fakeHost();
    await createHelpers(host).press_key('a', 2);
    const kinds = calls.filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params.type);
    assert.deepEqual(kinds, ['keyDown', 'keyUp']);
    assert.equal(calls.find(c => c.params.type === 'keyDown')!.params.modifiers, 2);
  });

  test("'Enter' uses the named-key table (vk 13)", async () => {
    const { host, calls } = fakeHost();
    await createHelpers(host).press_key('Enter');
    const down = calls.find(c => c.params.type === 'keyDown')!;
    assert.equal(down.params.windowsVirtualKeyCode, 13);
    assert.equal(down.params.code, 'Enter');
  });

  test('CJK char has no physical code; types via text only', async () => {
    const { host, calls } = fakeHost();
    await createHelpers(host).press_key('你');
    const kinds = calls.filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params.type);
    assert.deepEqual(kinds, ['keyDown', 'char', 'keyUp']);
    assert.equal(calls.find(c => c.params.type === 'keyDown')!.params.code, '');
    assert.equal(calls.find(c => c.params.type === 'char')!.params.text, '你');
  });
});

describe('list_tabs', () => {
  function withTargets(targets: Array<{ targetId: string; url: string; title?: string }>) {
    return fakeHost({ 'Target.getTargets': () => ({ targetInfos: targets.map(t => ({ type: 'page', ...t })) }) });
  }

  test('strips the horse marker from titles, keeps both id spellings', async () => {
    const { host } = withTargets([
      { targetId: 'T1', url: 'https://a.example/', title: `${MARKER_PREFIX}Marked` },
      { targetId: 'T2', url: 'https://b.example/', title: 'Plain' },
    ]);
    const tabs = await createHelpers(host).list_tabs();
    assert.deepEqual(tabs.map(t => t.title), ['Marked', 'Plain']);
    assert.equal(tabs[0]!.targetId, 'T1');
    assert.equal(tabs[0]!.target_id, 'T1');
  });

  test('filters agent startup placeholders and (optionally) internal pages', async () => {
    const { host } = withTargets([
      { targetId: 'P', url: 'about:blank#x', title: 'Starting agent Chrome' },
      { targetId: 'C', url: 'chrome://settings/', title: 'Settings' },
      { targetId: 'R', url: 'https://real.example/', title: 'Real' },
    ]);
    const h = createHelpers(host);
    assert.deepEqual((await h.list_tabs()).map(t => t.targetId), ['C', 'R']); // placeholder always gone
    assert.deepEqual((await h.list_tabs(false)).map(t => t.targetId), ['R']); // internal filtered on demand
  });
});

describe('tab lifecycle', () => {
  test('new_tab reuses a blank current tab via goto (no createTarget)', async () => {
    const { host, calls, setTabInfo } = fakeHost();
    setTabInfo({ targetId: 't1', url: 'about:blank', title: '' });
    await createHelpers(host).new_tab('https://target.example/');
    assert.equal(calls.some(c => c.method === 'Target.createTarget'), false);
    assert.ok(calls.some(c => c.method === 'Page.navigate' && c.params.url === 'https://target.example/'));
  });

  test('new_tab on a live page creates a BACKGROUND blank tab first (anti race, anti focus steal)', async () => {
    const { host, calls } = fakeHost({
      'Target.createTarget': () => ({ targetId: 'TNEW' }),
      'Target.attachToTarget': () => ({ sessionId: 's2' }),
    });
    await createHelpers(host).new_tab('https://target.example/');
    const create = calls.find(c => c.method === 'Target.createTarget');
    assert.ok(create);
    assert.deepEqual(create!.params, { url: 'about:blank', background: true });
  });

  test('switch_tab unmarks the old page, attaches, then re-marks the new one', async () => {
    const { host, calls } = fakeHost({ 'Target.attachToTarget': () => ({ sessionId: 's2' }) });
    await createHelpers(host).switch_tab('T9');
    const evaluates = calls.filter(c => c.method === 'Runtime.evaluate').map(c => c.params.expression);
    assert.ok(evaluates.some(e => /document\.title=document\.title\.slice\(3\)/.test(e)), 'unmark old');
    assert.ok(evaluates.some(e => /document\.title='.*\+document\.title/.test(e)), 'mark new');
    assert.ok(calls.some(c => c.method === 'Target.attachToTarget' && c.params.targetId === 'T9' && c.params.flatten === true));
  });
});

describe('js evaluation', () => {
  test('Illegal return statement is retried wrapped in an IIFE', async () => {
    let first = true;
    const { host, calls } = fakeHost({
      'Runtime.evaluate': (p: any) => {
        if (first && /return /.test(p.expression)) {
          first = false;
          throw new Error('CDP -32000: Runtime.evaluate Illegal return statement');
        }
        return { result: { value: 7 } };
      },
    });
    const v = await createHelpers(host).js('return 1+2');
    assert.equal(v, 7);
    const exprs = calls.filter(c => c.method === 'Runtime.evaluate').map(c => c.params.expression);
    assert.ok(exprs.some(e => e.startsWith('(function(){')));
  });

  test('target_id form evaluates in an isolated flatten session, detached after', async () => {
    const { host, calls } = fakeHost({
      'Target.attachToTarget': () => ({ sessionId: 'iframe-sess' }),
      'Runtime.evaluate': () => ({ result: { value: 'ok' } }),
    });
    const v = await createHelpers(host).js('1', 'TIF');
    assert.equal(v, 'ok');
    assert.ok(calls.some(c => c.method === 'Runtime.attachToTarget') === false);
    assert.ok(calls.some(c => c.method === 'Runtime.evaluate' && c.opts?.sessionId === 'iframe-sess'));
    assert.ok(calls.some(c => c.method === 'Target.detachFromTarget' && c.params.sessionId === 'iframe-sess'));
  });
});

describe('wait_for_network_idle', () => {
  test('goes idle once in-flight requests for the ACTIVE session settle', async () => {
    let round = 0;
    const batches: Array<Array<{ method: string; params: any; sessionId?: string }>> = [
      [{ method: 'Network.requestWillBeSent', params: { requestId: 'r1' }, sessionId: 's1' },
       { method: 'Network.requestWillBeSent', params: { requestId: 'r2' }, sessionId: 's1' }],
      [{ method: 'Network.loadingFinished', params: { requestId: 'r1' }, sessionId: 's1' },
       { method: 'Network.loadingFailed', params: { requestId: 'r2' }, sessionId: 's1' },
       // background tab noise must not count
       { method: 'Network.requestWillBeSent', params: { requestId: 'other' }, sessionId: 's2' }],
      [],
    ];
    const { host } = fakeHost();
    (host as any).drainEvents = async () => batches[Math.min(round++, batches.length - 1)] ?? [];
    const ok = await createHelpers(host).wait_for_network_idle(3, 100);
    assert.equal(ok, true);
  });
});

describe('recorder trace hook', () => {
  test('withTrace reports success and failure with duration and error', async () => {
    const { host } = fakeHost({ 'Page.navigate': () => ({ frameId: 'f1', url: 'https://x/' }) });
    const events: Array<{ name: string; ms: number; error?: unknown }> = [];
    const h = createHelpers(host, { onAction: (name, _args, ms, error) => events.push({ name, ms, error }) });
    await h.goto_url('https://x/');
    await assert.rejects(h.fill_input('#nope', 'text'), /element not found/);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.name, 'goto_url');
    assert.equal(events[0]!.error, undefined);
    assert.equal(events[1]!.name, 'fill_input');
    assert.ok(events[1]!.error);
  });
});
