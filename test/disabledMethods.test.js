// node --test test/   (no network; the middleware with fake Express req/res)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rejectDisabledMethods, disabledError } from '../utils/disabledMethods.js';

const item = (id, method) => ({ jsonrpc: '2.0', id, method, params: [] });

// Runs the middleware; returns what it answered, or 'next' if it passed the request on.
function run(body) {
  const req = { method: 'POST', body, headers: {}, socket: {} };
  const out = { status: null, body: null, next: false };
  const res = {
    status(s) { out.status = s; return res; },
    json(b) { out.body = b; return res; },
    send(b) { out.body = b; return res; }
  };
  rejectDisabledMethods(req, res, () => { out.next = true; });
  return { out, req, res };
}

test('eth_subscribe / eth_unsubscribe: -32601 with a WebSocket hint, HTTP 200, not forwarded', () => {
  for (const m of ['eth_subscribe', 'eth_unsubscribe']) {
    const { out } = run(item(1, m));
    assert.equal(out.next, false);
    assert.equal(out.status, 200);
    assert.equal(out.body.id, 1);
    assert.equal(out.body.error.code, -32601);
    assert.match(out.body.error.message, new RegExp(`^${m} requires a WebSocket connection; this endpoint is HTTP only`));
  }
});

test('filter methods keep their D15 message', () => {
  assert.equal(disabledError(item(2, 'eth_newFilter')).error.message,
    'eth_newFilter is not supported on this endpoint; use eth_getLogs');
});

test('other methods pass through', () => {
  assert.equal(run(item(3, 'eth_blockNumber')).out.next, true);
});

test('batch: a subscription item is answered at its position, the rest is forwarded', () => {
  const body = [item('a', 'eth_blockNumber'), item('b', 'eth_subscribe'), item('c', 'eth_chainId')];
  const { out, req, res } = run(body);
  assert.equal(out.next, true);
  assert.deepEqual(req.body.map(i => i.id), ['a', 'c']);
  res.send([{ jsonrpc: '2.0', id: 'a', result: '0x1' }, { jsonrpc: '2.0', id: 'c', result: '0x1' }]);
  assert.deepEqual(out.body.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(out.body[1].error.code, -32601);
  assert.match(out.body[1].error.message, /^eth_subscribe requires a WebSocket/);
});

test('batch: all items refused → array of errors, nothing forwarded', () => {
  const { out } = run([item(1, 'eth_subscribe'), item(2, 'eth_newBlockFilter')]);
  assert.equal(out.next, false);
  assert.deepEqual(out.body.map(r => r.error.code), [-32601, -32601]);
  assert.match(out.body[1].error.message, /use eth_getLogs$/);
});
