import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradePlan, type DaemonDrift, type UpgradeState } from './admin.js';

const d = (name: string, version: string | null): DaemonDrift => ({ name, port: 9900, version });
const st = (o: Partial<UpgradeState>): UpgradeState => ({ drift: [], xIntelRunning: false, dashboardAlive: false, namedDaemons: [], ...o });

test('upgradePlan: full stack running — teardown top-down, restore bottom-up', () => {
  const steps = upgradePlan(st({ drift: [d('default', '0.3.1'), d('x-intel', '0.3.1'), d('page-detect', '0.3.1')], xIntelRunning: true, dashboardAlive: true, namedDaemons: ['page-detect'] }));
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
  const steps = upgradePlan(st({ drift: [d('default', null)], dashboardAlive: true }));
  assert.ok(!steps.some(s => s.startsWith('x-intel')));
});

test('upgradePlan: dashboard down — stays down', () => {
  const steps = upgradePlan(st({ drift: [d('default', '0.3.1')] }));
  assert.ok(!steps.some(s => s.includes('dashboard')));
  // bare minimum: companions + default rebirth + final check always present
  assert.ok(steps.some(s => s.startsWith('default daemon 重生')));
  assert.equal(steps.at(-1), '终验：全部 daemon health.version 对版、看板 200');
});

test('upgradePlan: drifted named daemon gets an explicit restart step', () => {
  const steps = upgradePlan(st({ drift: [d('page-detect', '0.4.1')], namedDaemons: ['page-detect'] }));
  const idx = steps.findIndex(s2 => s2.startsWith('page-detect daemon 重生'));
  assert.ok(idx > 0, 'named daemon step exists');
  assert.ok(idx > steps.findIndex(s2 => s2.startsWith('default daemon 重生')), 'after default rebirth');
});

test('upgradePlan: pre-0.4.0 daemon (null version) still rolls', () => {
  const steps = upgradePlan(st({ drift: [d('page-detect', null)], namedDaemons: ['page-detect'] }));
  assert.ok(steps.length >= 3);
});
