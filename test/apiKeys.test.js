import test from 'node:test';
import assert from 'node:assert/strict';
import { setApiKeys, resolveApiKey, normalizeApiKey, extractApiKey, getApiKeyStoreStatus } from '../utils/apiKeys.js';

const KEY = 'ab'.repeat(8); // 16 hex, the shape rpc-token-manager mints (built at runtime so secret scanners stay quiet)

test('no key presented is the anonymous path', () => {
  setApiKeys([{ key: KEY, owner: '0xabc' }]);
  assert.deepEqual(resolveApiKey({ params: {}, headers: {} }), { status: 'none' });
});

test('key in URL path or header resolves to its owner', () => {
  setApiKeys([{ key: KEY, owner: '0xabc' }]);
  assert.deepEqual(resolveApiKey({ params: { key: KEY }, headers: {} }), { status: 'valid', key: KEY, owner: '0xabc' });
  assert.deepEqual(resolveApiKey({ params: {}, headers: { 'x-api-key': KEY.toUpperCase() } }), { status: 'valid', key: KEY, owner: '0xabc' });
});

test('unknown, revoked and malformed keys are invalid, not anonymous', () => {
  setApiKeys([{ key: KEY, owner: '0xabc' }, { key: 'ff'.repeat(8), owner: '0xdef', revoked: true }]);
  assert.equal(resolveApiKey({ params: { key: 'ff'.repeat(8) }, headers: {} }).status, 'invalid');
  assert.equal(resolveApiKey({ params: { key: '01'.repeat(8) }, headers: {} }).status, 'invalid');
  assert.equal(resolveApiKey({ params: { key: 'not-a-key' }, headers: {} }).status, 'invalid');
  assert.equal(resolveApiKey({ params: { key: '../etc' }, headers: {} }).status, 'invalid');
});

test('path wins over header when both are present', () => {
  setApiKeys([{ key: KEY, owner: '0xabc' }]);
  assert.equal(extractApiKey({ params: { key: KEY }, headers: { 'x-api-key': 'ff'.repeat(8) } }), KEY);
});

test('normalizeApiKey only accepts hex of a sane length', () => {
  assert.equal(normalizeApiKey(' ' + KEY.toUpperCase() + ' '), KEY);
  assert.equal(normalizeApiKey('abc'), null);
  assert.equal(normalizeApiKey('g'.repeat(16)), null);
  assert.equal(normalizeApiKey(42), null);
});

test('status exposes counts only', () => {
  setApiKeys([{ key: KEY, owner: '0xabc' }]);
  const st = getApiKeyStoreStatus();
  assert.equal(st.ready, true);
  assert.equal(st.keyCount, 1);
  assert.equal(JSON.stringify(st).includes(KEY), false);
});
