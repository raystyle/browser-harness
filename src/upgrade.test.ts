import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradePlan, type DaemonDrift } from './admin.js';

const d = (name: string, version: string | null): DaemonDrift => ({ name, port: 9900, version });

test('upgradePlan: full stack running — teardown top-down, restore bottom-up', () => {
  const steps = upgradePlan({ drift: [d('default', '0.3.1'), d('x-intel', '0.3.1')], xIntelRunning: true, dashboardAlive: true });
  const labels = steps.map(s => s.split('（')[0] ?? s);
  // Stop order: x-intel stack FIRST (so supervisor can't re-pull mid-swap),
  // then companions, then the default daemon is reborn; restore is reverse.
  assert.ok(labels.indexOf('x-intel stop') < labels.indexOf('停 companions 会话'));
  assert.ok(labels.indexOf('停 companions 会话') < labels.indexOf('default daemon 重生'));
  assert.ok(labels.indexOf('default daemon 重生') < labels.indexOf('dashboard stop + 起新'));
  assert.ok(labels.indexOf('dashboard stop + 起新') < labels.indexOf('x-intel start'));
  assert.equal(steps.at(-1), '终验：全部 daemon health.version 对版、看板 200');
});

test('upgradePlan: x-intel down — never started, never "restored"', () => {
  const steps = upgradePlan({ drift: [d('default', null)], xIntelRunning: false, dashboardAlive: true });
  assert.ok(!steps.some(s => s.startsWith('x-intel')));
});

test('upgradePlan: dashboard down — stays down', () => {
  const steps = upgradePlan({ drift: [d('default', '0.3.1')], xIntelRunning: false, dashboardAlive: false });
  assert.ok(!steps.some(s => s.includes('dashboard')));
  // bare minimum: companions + default rebirth + final check always present
  assert.ok(steps.some(s => s.startsWith('default daemon 重生')));
  assert.equal(steps.at(-1), '终验：全部 daemon health.version 对版、看板 200');
});

test('upgradePlan: pre-0.4.0 daemon (null version) still rolls', () => {
  const steps = upgradePlan({ drift: [d('page-detect', null)], xIntelRunning: false, dashboardAlive: false });
  assert.ok(steps.length >= 3);
});
