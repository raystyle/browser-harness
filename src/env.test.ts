import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { envNumber, envSeconds, envTriBool, envSetDefault, clamp } from './env.js';

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const k of Object.keys(vars)) {
    saved.set(k, process.env[k]);
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe('env parsing (setdefault semantics: bad values never throw)', () => {
  test('envNumber falls back on missing, empty, invalid and <=0', async () => {
    await withEnv({ BH_T: undefined }, async () => {
      assert.equal(envNumber('BH_T', 42), 42);
    });
    await withEnv({ BH_T: '' }, async () => {
      assert.equal(envNumber('BH_T', 42), 42);
    });
    await withEnv({ BH_T: 'not-a-number' }, async () => {
      assert.equal(envNumber('BH_T', 42), 42);
    });
    await withEnv({ BH_T: '0' }, async () => {
      assert.equal(envNumber('BH_T', 42), 42);
    });
    await withEnv({ BH_T: '-5' }, async () => {
      assert.equal(envNumber('BH_T', 42), 42);
    });
    await withEnv({ BH_T: '7' }, async () => {
      assert.equal(envNumber('BH_T', 42), 7);
    });
  });

  test('envSeconds is an alias of envNumber', async () => {
    await withEnv({ BH_T: '3' }, async () => {
      assert.equal(envSeconds('BH_T', 1), 3);
    });
  });

  test('envTriBool: 1/true/yes/on -> true; 0/false/no/off -> false; junk/unset -> undefined', async () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'On']) {
      await withEnv({ BH_T: v }, async () => assert.equal(envTriBool('BH_T'), true, v));
    }
    for (const v of ['0', 'false', 'No', 'off', 'OFF']) {
      await withEnv({ BH_T: v }, async () => assert.equal(envTriBool('BH_T'), false, v));
    }
    for (const v of ['junk', '2', 'maybe']) {
      await withEnv({ BH_T: v }, async () => assert.equal(envTriBool('BH_T'), undefined, v));
    }
    await withEnv({ BH_T: undefined }, async () => {
      assert.equal(envTriBool('BH_T'), undefined);
    });
  });

  test('envSetDefault: the real process environment always wins', async () => {
    await withEnv({ BH_T: 'real' }, async () => {
      envSetDefault('BH_T', 'default');
      assert.equal(process.env.BH_T, 'real');
    });
    await withEnv({ BH_T: undefined }, async () => {
      envSetDefault('BH_T', 'default');
      assert.equal(process.env.BH_T, 'default');
    });
    await withEnv({ BH_T: '' }, async () => {
      envSetDefault('BH_T', 'default');
      assert.equal(process.env.BH_T, 'default');
    });
  });

  test('clamp pins into [lo, hi]', () => {
    assert.equal(clamp(5, 1, 10), 5);
    assert.equal(clamp(0, 1, 10), 1);
    assert.equal(clamp(99, 1, 10), 10);
  });
});
