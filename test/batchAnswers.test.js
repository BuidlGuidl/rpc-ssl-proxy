// node --test test/   (no network; pure functions plus a fake Express response)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perItem, jsonRpcError } from '../utils/errorMessages.js';
import { spliceIntoBatchResponse } from '../utils/batchMerge.js';
import { itemProblem } from '../utils/requestValidator.js';

const err = (id, code = -32005, message = 'Rate limit exceeded.') => jsonRpcError(id, code, message);
const item = (id, method = 'eth_chainId') => ({ jsonrpc: '2.0', id, method, params: [] });

test('perItem: one error for a batch becomes one copy per item with each id (0 kept)', () => {
  const body = [item(0), item('b'), item(null), { method: 'x' }];
  const out = perItem(body, err(0));
  assert.equal(out.length, 4);
  assert.deepEqual(out.map(a => a.id), [0, 'b', null, null]);
  for (const a of out) { assert.equal(a.jsonrpc, '2.0'); assert.deepEqual(a.error, err(0).error); }
});

test('perItem: an array answer passes unchanged', () => {
  const arr = [err(1), { jsonrpc: '2.0', id: 2, result: '0x1' }];
  assert.equal(perItem([item(1), item(2)], arr), arr);
});

test('perItem: a single (non-batch) request passes unchanged', () => {
  const e = err(7);
  assert.equal(perItem(item(7), e), e);
});

test('perItem: a success body passes unchanged', () => {
  const ok = { jsonrpc: '2.0', id: 1, result: '0x1' };
  assert.equal(perItem([item(1)], ok), ok);
});

// A minimal stand-in for res: captures what reaches the original send.
function fakeRes() {
  const r = { sent: [] };
  r.send = function (body) { r.sent.push(body); return r; };
  return r;
}

test('batchMerge: a single error object plus spliced entries fills every position in order', () => {
  const remaining = [item(10), item(30)];                       // items left after removal
  const entries = [{ index: 1, response: err(20, -32600, 'bad') }, { index: 3, response: err(40, -32601, 'nope') }];
  const res = fakeRes();
  spliceIntoBatchResponse(res, entries, remaining);
  res.send(err(10, -32005, 'Rate limit exceeded: whole batch'));      // handler answered one object
  const out = res.sent[0];
  assert.ok(Array.isArray(out));
  assert.deepEqual(out.map(a => a.id), [10, 20, 30, 40]);
  assert.equal(out[0].error.message, 'Rate limit exceeded: whole batch');
  assert.equal(out[2].error.message, 'Rate limit exceeded: whole batch');
  assert.equal(out[1].error.code, -32600);
  assert.equal(out[3].error.code, -32601);
});

test('batchMerge: a string body with a single error object is expanded and re-serialized', () => {
  const res = fakeRes();
  spliceIntoBatchResponse(res, [{ index: 0, response: err('a') }], [item('b')]);
  res.send(JSON.stringify(err('b')));
  const out = JSON.parse(res.sent[0]);
  assert.deepEqual(out.map(a => a.id), ['a', 'b']);
});

test('batchMerge: an array body still gets entries spliced at their positions', () => {
  const res = fakeRes();
  spliceIntoBatchResponse(res, [{ index: 0, response: err('x') }], [item(1), item(2)]);
  res.send([{ jsonrpc: '2.0', id: 1, result: 1 }, { jsonrpc: '2.0', id: 2, result: 2 }]);
  assert.deepEqual(res.sent[0].map(a => a.id), ['x', 1, 2]);
});

test('itemProblem: an id that is not a string, number or null is rejected and echoed as null', () => {
  for (const bad of [{}, [], true, { a: 1 }]) {
    const p = itemProblem({ jsonrpc: '2.0', id: bad, method: 'eth_chainId' }, false);
    assert.equal(p.code, -32600);
    assert.equal(p.message, 'Invalid Request: id must be a string, number or null');
    assert.equal(p.id, null);
  }
  for (const good of ['s', 0, 7, null]) {
    assert.equal(itemProblem({ jsonrpc: '2.0', id: good, method: 'eth_chainId' }, false), null);
  }
});

test('itemProblem: a non-object item is "request must be an object" with id null', () => {
  for (const bad of [null, 5, 'x', [], undefined]) {
    const p = itemProblem(bad, false);
    assert.equal(p.code, -32600);
    assert.equal(p.message, 'Invalid Request: request must be an object');
    assert.equal(p.id, null);
  }
});

test('itemProblem: existing checks keep their id and messages', () => {
  assert.equal(itemProblem({ id: 3 }, false).message, 'Invalid Request: jsonrpc missing, method missing');
  assert.equal(itemProblem({ id: 3 }, false).id, 3);
  assert.equal(itemProblem({ jsonrpc: '2.0', id: 4, method: ['x'] }, false).message, 'Invalid Request: method must be a string');
  assert.equal(itemProblem({ jsonrpc: '2.0', id: 5, method: 'debug_x' }, false).code, -32601);
});
