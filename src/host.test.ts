import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isDashboardUrl } from './host.js';

describe('isDashboardUrl (exact origin, not prefix)', () => {
  test('matches the three loopback hosts on the exact port, with any path', () => {
    assert.ok(isDashboardUrl('http://127.0.0.1:9870/'));
    assert.ok(isDashboardUrl('http://127.0.0.1:9870'));
    assert.ok(isDashboardUrl('http://localhost:9870/snapshot?x=1'));
    assert.ok(isDashboardUrl('http://[::1]:9870/'));
  });

  test('a longer port sharing the prefix is NOT the control plane (98700/98701)', () => {
    assert.equal(isDashboardUrl('http://127.0.0.1:98700/app'), false);
    assert.equal(isDashboardUrl('http://localhost:98701'), false);
    assert.equal(isDashboardUrl('http://[::1]:98700/'), false);
  });

  test('other hosts, ports and schemes are workable pages', () => {
    assert.equal(isDashboardUrl('https://127.0.0.1:9870/'), false);
    assert.equal(isDashboardUrl('http://127.0.0.1:9871/'), false);
    assert.equal(isDashboardUrl('http://example.com:9870/'), false);
    assert.equal(isDashboardUrl('https://example.com/'), false);
    assert.equal(isDashboardUrl('about:blank'), false);
    assert.equal(isDashboardUrl(''), false);
  });

  test('BH_DASHBOARD_PORT override is honored', () => {
    const saved = process.env.BH_DASHBOARD_PORT;
    process.env.BH_DASHBOARD_PORT = '9999';
    try {
      assert.ok(isDashboardUrl('http://127.0.0.1:9999/'));
      assert.equal(isDashboardUrl('http://127.0.0.1:9870/'), false);
    } finally {
      if (saved === undefined) delete process.env.BH_DASHBOARD_PORT;
      else process.env.BH_DASHBOARD_PORT = saved;
    }
  });
});
