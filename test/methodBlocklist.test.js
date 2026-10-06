// node --test test/   (no network; the two refusal middlewares, in proxy.js order, with fake req/res)
// bg-rpc-docs EDGE_METHOD_BLOCKLIST_PLAN.md, Phase 1 (D2, D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRpcRequest } from '../utils/requestValidator.js';
import { rejectDisabledMethods } from '../utils/disabledMethods.js';
import { disabledMethods, wsOnlyMethods, unsupportedMethods } from '../config.js';

const item = (id, method, params = []) => ({ jsonrpc: '2.0', id, method, params });

// Runs validateRpcRequest then rejectDisabledMethods, like proxy.js. If both pass the request
// on, the "handler" answers each forwarded item with a result, as upstream would.
function pipeline(body, headers = {}) {
  const req = { method: 'POST', body, headers, socket: {} };
  const out = { status: null, body: null, forwarded: null };
  const res = {
    status(s) { out.status = s; return res; },
    // like Express: json() serializes and goes through send(), where batch splices hook in
    json(b) { return res.send(JSON.stringify(b)); },
    send(b) { out.body = typeof b === 'string' ? JSON.parse(b) : b; return res; }
  };
  validateRpcRequest(req, res, () => {
    rejectDisabledMethods(req, res, () => {
      out.forwarded = req.body;
      const served = (i) => ({ jsonrpc: '2.0', id: i.id, result: '0x1' });
      res.status(200);
      res.send(Array.isArray(req.body) ? req.body.map(served) : served(req.body));
    });
  });
  return out;
}

const NAMESPACES = ['trace', 'txpool', 'rpc', 'erigon', 'alchemy', 'parity', 'ots', 'proof'];
const NS_METHODS = {
  trace: ['trace_block', 'trace_transaction', 'trace_call', 'trace_filter'],
  txpool: ['txpool_status', 'txpool_content', 'txpool_inspect'],
  rpc: ['rpc_modules'],
  erigon: ['erigon_getHeaderByNumber'],
  alchemy: ['alchemy_getTokenBalances', 'alchemy_getAssetTransfers'],
  parity: ['parity_pendingTransactions'],
  ots: ['ots_getApiLevel'],
  proof: ['proof_getTransactionByHash']
};
const METHODS = ['eth_coinbase', 'eth_mining', 'eth_hashrate', 'eth_getWork', 'eth_submitWork', 'eth_submitHashrate',
  'eth_sendTransaction', 'eth_sign', 'eth_signTransaction',
  'eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v3', 'eth_signTypedData_v4'];
const KEYLESS = ['eth_sendTransaction', 'eth_sign', 'eth_signTransaction'];
const TYPED_DATA = ['eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v3', 'eth_signTypedData_v4'];
// Served, and sharing a prefix with something refused.
const SERVED = ['eth_call', 'eth_getTransactionCount', 'net_version', 'eth_accounts', 'eth_getProof',
  'eth_sendRawTransaction', 'eth_blockNumber', 'eth_getTransactionByHash', 'eth_getLogs'];

test('every D2 namespace: -32601 with the existing namespace message, not forwarded', () => {
  for (const ns of NAMESPACES) {
    for (const m of NS_METHODS[ns]) {
      const out = pipeline(item(7, m));
      assert.equal(out.forwarded, null, m);
      assert.equal(out.status, 200, m);
      assert.equal(out.body.id, 7, m);
      assert.equal(out.body.error.code, -32601, m);
      assert.equal(out.body.error.message, `Method not supported: The '${ns}' namespace is not available on this endpoint`, m);
    }
  }
});

test('every D2 method: -32601 "<method> is not supported on this endpoint", hint on the keyless ones, not forwarded', () => {
  assert.deepEqual(Object.keys(unsupportedMethods).sort(), [...METHODS].sort());
  for (const m of METHODS) {
    const out = pipeline(item('x', m));
    assert.equal(out.forwarded, null, m);
    assert.equal(out.status, 200, m);
    assert.equal(out.body.id, 'x', m);
    assert.equal(out.body.error.code, -32601, m);
    const expected = `${m} is not supported on this endpoint` +
      (KEYLESS.includes(m) ? '; sign locally and use eth_sendRawTransaction' : '') +
      (TYPED_DATA.includes(m) ? '; sign typed data in your wallet' : '');
    assert.equal(out.body.error.message, expected, m);
  }
});

test('served methods sharing a prefix pass through untouched', () => {
  for (const m of SERVED) {
    const out = pipeline(item(1, m));
    assert.deepEqual(out.forwarded, item(1, m), m);
    assert.equal(out.body.result, '0x1', m);
  }
});

test('batch: refused items answered at their position, the rest forwarded and served in order', () => {
  const body = [
    item(1, 'eth_blockNumber'),
    item(2, 'trace_block', ['latest']),
    item(3, 'eth_call'),
    item(4, 'eth_sendTransaction'),
    item(5, 'rpc_modules'),
    item(6, 'eth_newFilter'),
    item(7, 'eth_accounts')
  ];
  const out = pipeline(body);
  assert.deepEqual(out.forwarded.map(i => i.id), [1, 3, 7]);
  assert.deepEqual(out.body.map(a => a.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(out.body.map(a => a.error?.code ?? 'ok'), ['ok', -32601, 'ok', -32601, -32601, -32601, 'ok']);
  assert.match(out.body[1].error.message, /'trace' namespace/);
  assert.match(out.body[3].error.message, /^eth_sendTransaction is not supported on this endpoint; sign locally/);
  assert.match(out.body[4].error.message, /'rpc' namespace/);
  assert.match(out.body[5].error.message, /use eth_getLogs$/);
});

test('batch: every typed-data method answered at its position between served items', () => {
  const body = [item(0, 'eth_chainId')];
  TYPED_DATA.forEach((m, i) => body.push(item(10 + i, m, ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '{}'])));
  body.push(item(99, 'eth_blockNumber'));
  const out = pipeline(body);
  assert.deepEqual(out.forwarded.map(i => i.id), [0, 99]);
  assert.deepEqual(out.body.map(a => a.id), [0, 10, 11, 12, 13, 99]);
  assert.equal(out.body[0].result, '0x1');
  assert.equal(out.body[5].result, '0x1');
  TYPED_DATA.forEach((m, i) => {
    assert.equal(out.body[1 + i].error.code, -32601);
    assert.equal(out.body[1 + i].error.message, `${m} is not supported on this endpoint; sign typed data in your wallet`);
  });
});

test('batch: all items refused → array of errors, nothing forwarded', () => {
  const out = pipeline([item(1, 'txpool_status'), item(2, 'eth_coinbase')]);
  assert.equal(out.forwarded, null);
  assert.deepEqual(out.body.map(a => [a.id, a.error.code]), [[1, -32601], [2, -32601]]);
});

test('disabledMethods (D15) and wsOnlyMethods unchanged', () => {
  assert.deepEqual(disabledMethods, ['eth_newFilter', 'eth_newBlockFilter', 'eth_newPendingTransactionFilter',
    'eth_getFilterChanges', 'eth_getFilterLogs', 'eth_uninstallFilter']);
  for (const m of disabledMethods) {
    assert.equal(pipeline(item(1, m)).body.error.message, `${m} is not supported on this endpoint; use eth_getLogs`);
  }
  for (const [m, msg] of Object.entries(wsOnlyMethods)) {
    assert.equal(pipeline(item(1, m)).body.error.message, msg);
  }
});

test('exempt-origin rule unchanged', () => {
  const client = { origin: 'buidlguidl-client' };
  const ens = '0xce01f8eee7e479c928f8919abd53e553a36cef67';
  assert.ok(pipeline(item(1, 'eth_blockNumber'), client).forwarded);
  assert.ok(pipeline(item(1, 'eth_call', [{ to: ens, data: '0x' }, 'latest']), client).forwarded);
  const other = pipeline(item(1, 'eth_getBalance', ['0x0', 'latest']), client);
  assert.equal(other.forwarded, null);
  assert.equal(other.body.error.message, 'Method not supported from this origin');
  // a refused namespace keeps the namespace answer, as blocked namespaces did before
  assert.match(pipeline(item(1, 'trace_block'), client).body.error.message, /'trace' namespace/);
});
