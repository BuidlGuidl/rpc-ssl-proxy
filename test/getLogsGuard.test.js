import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGetLogsParams } from '../utils/getLogsGuard.js';

const hex = n => '0x' + n.toString(16);

test('rejects a missing or non-object filter', () => {
  assert.equal(checkGetLogsParams([], 100, 2000).ok, false);
  assert.equal(checkGetLogsParams(['x'], 100, 2000).ok, false);
  assert.equal(checkGetLogsParams(undefined, 100, 2000).ok, false);
});

test('blockHash filters are always a single block', () => {
  const r = checkGetLogsParams([{ blockHash: '0xabc' }], null, 2000);
  assert.deepEqual(r, { ok: true, range: 1 });
});

test('explicit hex range within the cap passes', () => {
  const r = checkGetLogsParams([{ fromBlock: hex(1000), toBlock: hex(2999) }], null, 2000);
  assert.deepEqual(r, { ok: true, range: 2000 });
});

test('explicit hex range one over the cap is refused', () => {
  const r = checkGetLogsParams([{ fromBlock: hex(1000), toBlock: hex(3000) }], null, 2000);
  assert.equal(r.ok, false);
  assert.match(r.message, /2001 exceeds the maximum of 2000/);
});

test('fromBlock after toBlock is refused', () => {
  assert.equal(checkGetLogsParams([{ fromBlock: hex(10), toBlock: hex(5) }], null, 2000).ok, false);
});

test('tags resolve against the cached head', () => {
  assert.equal(checkGetLogsParams([{ fromBlock: hex(9000), toBlock: 'latest' }], 10000, 2000).ok, true);
  assert.equal(checkGetLogsParams([{ fromBlock: hex(7000), toBlock: 'latest' }], 10000, 2000).ok, false);
  assert.equal(checkGetLogsParams([{}], 10000, 2000).ok, true); // latest..latest
  assert.equal(checkGetLogsParams([{ fromBlock: 'finalized', toBlock: 'pending' }], 10000, 2000).ok, true);
});

test('earliest is block 0 and gets refused on a real chain', () => {
  const r = checkGetLogsParams([{ fromBlock: 'earliest', toBlock: hex(5000) }], null, 2000);
  assert.equal(r.ok, false);
});

test('a tag with no cached head asks for explicit numbers', () => {
  const r = checkGetLogsParams([{ fromBlock: hex(1), toBlock: 'latest' }], null, 2000);
  assert.equal(r.ok, false);
  assert.match(r.message, /explicit hex block number/);
});

test('garbage block values are refused', () => {
  assert.equal(checkGetLogsParams([{ fromBlock: 'nope' }], 10, 2000).ok, false);
  assert.equal(checkGetLogsParams([{ fromBlock: -1 }], 10, 2000).ok, false);
  assert.equal(checkGetLogsParams([{ fromBlock: {} }], 10, 2000).ok, false);
});
