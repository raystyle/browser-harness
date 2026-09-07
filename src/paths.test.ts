import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_NAME,
  homeDir, workspaceDir,
  instanceName, derivedPort,
  writeInstanceRecord, readInstanceRecord,
  logFile, loadEnvFiles,
} from './paths.js';

// Per-file sandbox: point BH_HOME / workspace at temp dirs so tests never
// touch the developer's installed stack or the repo's .bh-dev tree.
const sandbox = mkdtempSync(path.join(tmpdir(), 'bh-paths-test-'));
const home = path.join(sandbox, 'home');
const ws = path.join(sandbox, 'ws');

const savedEnv: Record<string, string | undefined> = {};
function pin(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

before(() => {
  pin('BH_HOME', home);
  pin('BH_BROWSER_WORKSPACE', ws);
  pin('BH_AGENT_WORKSPACE', undefined);
  pin('BH_AGENT_CHROME_PROFILE', undefined);
  pin('BH_PORT', undefined);
  pin('BH_NAME', undefined);
  pin('BH_TEST_A', undefined);
  pin('BH_TEST_B', undefined);
  pin('BH_TEST_C', undefined);
  process.env.BH_HOME = home;
  process.env.BH_BROWSER_WORKSPACE = ws;
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('BH_HOME path system', () => {
  test('homeDir honors the BH_HOME pin', () => {
    assert.equal(homeDir(), path.resolve(home));
  });

  test('workspaceDir honors its pin over the legacy alias', () => {
    assert.equal(workspaceDir(), path.resolve(ws));
  });
});

describe('BH_NAME multi-instance', () => {
  test('unset or empty BH_NAME means the default instance', () => {
    delete process.env.BH_NAME;
    assert.equal(instanceName(), DEFAULT_NAME);
    process.env.BH_NAME = '';
    assert.equal(instanceName(), DEFAULT_NAME);
  });

  test('invalid names throw (they would corrupt registry filenames)', () => {
    for (const bad of ['has space', 'bad/name', 'naïve', 'x'.repeat(65)]) {
      process.env.BH_NAME = bad;
      assert.throws(() => instanceName(), /BH_NAME must match/, bad);
    }
    delete process.env.BH_NAME;
  });

  test('derivedPort: BH_PORT wins, default keeps 9876, named is stable in range', () => {
    delete process.env.BH_NAME;
    assert.equal(derivedPort(), 9876);
    process.env.BH_PORT = '1234';
    assert.equal(derivedPort(), 1234);
    delete process.env.BH_PORT;
    process.env.BH_NAME = 'x-monitor';
    const p1 = derivedPort();
    const p2 = derivedPort();
    assert.equal(p1, p2); // deterministic hash
    assert.ok(p1 >= 9877 && p1 <= 9996, `port in derived range: ${p1}`);
    delete process.env.BH_NAME;
  });

  test('instance registry round-trips; missing/corrupt records read as undefined', () => {
    writeInstanceRecord('x-monitor', 4567);
    const rec = readInstanceRecord('x-monitor');
    assert.ok(rec);
    assert.equal(rec.port, 4567);
    assert.equal(rec.pid, process.pid);
    assert.equal(readInstanceRecord('never-started'), undefined);
    // default instance keeps the legacy bh.port filename
    writeInstanceRecord(DEFAULT_NAME, 9876);
    assert.equal(readInstanceRecord(DEFAULT_NAME)?.port, 9876);
    // corrupt JSON degrades to undefined, never throws
    const runtime = path.join(home, 'runtime');
    writeFileSync(path.join(runtime, 'bh-corrupt.port'), '{not json');
    assert.equal(readInstanceRecord('corrupt'), undefined);
  });

  test('logFile: default keeps legacy bh.log, named gets the suffix', () => {
    delete process.env.BH_NAME;
    assert.equal(logFile(DEFAULT_NAME), path.join(home, 'tmp', 'bh.log'));
    assert.equal(logFile('x-monitor'), path.join(home, 'tmp', 'bh-x-monitor.log'));
  });
});

describe('loadEnvFiles (setdefault chain)', () => {
  test('real env wins; home .env wins over workspace .env; quotes stripped; comments skipped', () => {
    process.env.BH_TEST_A = 'real';
    writeFileSync(path.join(home, '.env'), [
      '# comment line',
      'BH_TEST_A=from-home',
      'BH_TEST_B="quoted-value"',
      '',
    ].join('\n'));
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, '.env'), [
      'BH_TEST_A=from-workspace',
      'BH_TEST_C=3',
      'malformed line without equals',
    ].join('\n'));
    loadEnvFiles();
    assert.equal(process.env.BH_TEST_A, 'real');      // process environment always wins
    assert.equal(process.env.BH_TEST_B, 'quoted-value'); // first file wins, quotes stripped
    assert.equal(process.env.BH_TEST_C, '3');          // additional keys from workspace .env
  });
});
