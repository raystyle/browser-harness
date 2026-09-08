import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRef } from './helpers.js';

test('parseRef: well-formed refs parse to version + index', () => {
  assert.deepEqual(parseRef('@m1abcd0:e0'), { version: 'm1abcd0', index: 0 });
  assert.deepEqual(parseRef('@lz9:e41'), { version: 'lz9', index: 41 });
});

test('parseRef: malformed refs throw BAD_REF with the value quoted', () => {
  for (const bad of ['', 'e1', '@v1:e', '@v1:e1x', 'v1:e1', '@:e1', '@V1:e1', null, undefined, 42]) {
    assert.throws(() => parseRef(bad as unknown as string), /BAD_REF: /);
  }
});

test('parseRef: index is numeric even for large indices', () => {
  assert.equal(parseRef('@abc:e999').index, 999);
});
