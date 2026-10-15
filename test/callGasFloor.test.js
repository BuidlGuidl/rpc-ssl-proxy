// node --test test/   (no network; pure functions plus a fake Express response)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callGasFloorProblem, callGasFloorRejects, calldataFloorGas } from '../utils/callGasFloor.js';
import { spliceIntoBatchResponse } from '../utils/batchMerge.js';
import { callGasCap } from '../config.js';

// 0x-hex calldata with `zero` zero bytes and `nonzero` 0xff bytes
const calldata = (zero, nonzero) => '0x' + '00'.repeat(zero) + 'ff'.repeat(nonzero);
const call = (id, data, gas, field = 'data') => ({
  jsonrpc: '2.0', id, method: 'eth_call',
  params: [{ to: '0xcA11bde05977b3631167028862bE2a173976CA11', [field]: data, ...(gas !== undefined ? { gas } : {}) }, 'latest']
});
const BIG = calldata(1_542_739, 437_489); // the byte mix of the 2026-10-13 Multicall3 call

test('calldataFloorGas: matches what the nodes reported for the 2026-10-13 call', () => {
  assert.equal(calldataFloorGas(BIG), 32_947_950);
  assert.equal(calldataFloorGas('0x'), 21000);
  assert.equal(calldataFloorGas('0x00ff'), 21000 + 10 + 40);
  assert.equal(calldataFloorGas('0xFF'), 21000 + 40);
});

test('calldataFloorGas: not hex bytes → null', () => {
  for (const bad of ['', 'ff', '0xf', '0xzz', 5, null]) assert.equal(calldataFloorGas(bad), null);
});

test('callGasFloorProblem: floor above the supplied gas → -32000 intrinsic gas too low', () => {
  const p = callGasFloorProblem(call(1, BIG, '0x1c9c380'), callGasCap); // 30M
  assert.equal(p.code, -32000);
  assert.equal(p.message, 'intrinsic gas too low');
  assert.match(p.reason, /floor 32947950 > gas 30000000/);
});

test('callGasFloorProblem: "input" is read like "data"; numeric gas accepted', () => {
  assert.ok(callGasFloorProblem(call(1, BIG, '0x1c9c380', 'input'), callGasCap));
  assert.ok(callGasFloorProblem(call(1, BIG, 30_000_000), callGasCap));
});

test('callGasFloorProblem: floor at or under the gas passes', () => {
  assert.equal(callGasFloorProblem(call(1, BIG, '0x1f6beee'), callGasCap), null); // exactly 32,947,950
  assert.ok(callGasFloorProblem(call(1, BIG, '0x1f6beed'), callGasCap));            // one below
  assert.equal(callGasFloorProblem(call(1, BIG), callGasCap), null);               // no gas: the 50M cap
});

test('callGasFloorProblem: small calldata with too little gas is refused too (certain to fail)', () => {
  // 4 nonzero bytes: floor 21,160 > gas 21,000; with 21,160 it passes
  assert.ok(callGasFloorProblem(call(1, '0x82ad56cb', '0x5208'), callGasCap));
  assert.equal(callGasFloorProblem(call(1, '0x82ad56cb', '0x52a8'), callGasCap), null);
});

test('callGasFloorProblem: no gas field uses the cap', () => {
  const overCap = calldata(0, 1_250_000); // floor 50,021,000
  assert.ok(callGasFloorProblem(call(1, overCap), callGasCap));
  assert.ok(callGasFloorProblem(call(1, overCap, null), callGasCap));
});

test('callGasFloorProblem: anything it cannot read is left to the node', () => {
  assert.equal(callGasFloorProblem(call(1, BIG, 'lots'), callGasCap), null);
  assert.equal(callGasFloorProblem(call(1, BIG, '0x'), callGasCap), null);
  assert.equal(callGasFloorProblem(call(1, BIG + 'f', '0x1'), callGasCap), null); // odd length
  assert.equal(callGasFloorProblem({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] }, callGasCap), null);
  assert.equal(callGasFloorProblem({ jsonrpc: '2.0', id: 1, method: 'eth_call' }, callGasCap), null);
  assert.equal(callGasFloorProblem({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: '0x1' }] }, callGasCap), null);
});

test('callGasFloorProblem: only eth_call', () => {
  const est = { ...call(1, BIG, '0x1c9c380'), method: 'eth_estimateGas' };
  assert.equal(callGasFloorProblem(est, callGasCap), null);
  assert.equal(callGasFloorProblem({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, callGasCap), null);
});

test('callGasFloorRejects: single request → one entry, id echoed, charged 1 unit', () => {
  const out = callGasFloorRejects(call('abc', BIG, '0x1c9c380'), callGasCap);
  assert.equal(out.length, 1);
  assert.equal(out[0].index, 0);
  assert.equal(out[0].units, 1);
  assert.deepEqual(out[0].response, { jsonrpc: '2.0', id: 'abc', error: { code: -32000, message: 'intrinsic gas too low' } });
  assert.deepEqual(callGasFloorRejects(call(1, '0x1234', '0x1c9c380'), callGasCap), []);
});

test('callGasFloorRejects: batch → only the bad items, at their positions; merged back in order', () => {
  const body = [
    { jsonrpc: '2.0', id: 0, method: 'eth_chainId' },
    call(1, BIG, '0x1c9c380'),
    call(2, '0x1234', '0x1c9c380'),
    call(3, BIG, '0x1c9c380')
  ];
  const rejected = callGasFloorRejects(body, callGasCap);
  assert.deepEqual(rejected.map(r => r.index), [1, 3]);
  assert.equal(rejected.reduce((s, r) => s + r.units, 0), 2);

  // What proxy.js does with them: forward the rest, splice the answers back
  const remaining = body.filter((_, i) => !rejected.some(r => r.index === i));
  const res = { sent: [] };
  res.send = function (b) { res.sent.push(b); return res; };
  spliceIntoBatchResponse(res, rejected, remaining);
  res.send([{ jsonrpc: '2.0', id: 0, result: '0x1' }, { jsonrpc: '2.0', id: 2, result: '0x' }]);
  const out = res.sent[0];
  assert.deepEqual(out.map(a => a.id), [0, 1, 2, 3]);
  assert.equal(out[1].error.message, 'intrinsic gas too low');
  assert.equal(out[2].result, '0x');
  assert.equal(out[3].error.code, -32000);
});
