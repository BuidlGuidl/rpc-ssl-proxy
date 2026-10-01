// node --test test/   (no network; classifyOrigin and the headers sent downstream)
// bg-rpc-docs ORIGIN_CLASS_PLAN.md, Phase 1 (D2, D7, D8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOrigin, checkRateLimit, isExemptOrigin, isLocalOrigin } from '../utils/rateLimiter.js';
import { normalizeOrigin } from '../utils/originValidator.js';
import { upstreamHeaders } from '../utils/upstreamHeaders.js';

// [origin, expected class] - the testOriginClassifier.js cases, plus the ones the plan names.
const CASES = [
  // real origins
  ['https://speedrunethereum.com', 'tracked'],
  ['https://app.buidlguidl.com', 'tracked'],
  ['https://bm-lyart.vercel.app', 'tracked'],
  ['https://a.b.c.example.co.uk', 'tracked'],
  ['https://xn--bcher-kva.com', 'tracked'],
  ['https://1024x.fun', 'tracked'],
  ['http://plain-http.com', 'tracked'],
  ['https://trailing.com/', 'tracked'],
  ['  https://padded.com  ', 'tracked'],
  ['HTTPS://SpeedRunEthereum.com', 'tracked'],
  ['HtTpS://Foo.CoM/', 'tracked'],
  ['https://example.com', 'tracked'],
  // exempt in every capitalization (D8)
  ['buidlguidl-client', 'exempt'],
  ['BuidlGuidl-Client', 'exempt'],
  ['BUIDLGUIDL-CLIENT', 'exempt'],
  ['buidlGuidl-client', 'exempt'],
  // localhost, with and without port
  ['http://localhost', 'untracked'],
  ['http://localhost:3000', 'untracked'],
  ['https://localhost', 'untracked'],
  ['HTTP://LOCALHOST:3000', 'untracked'],
  ['localhost', 'untracked'],
  // loopback and private IPs, with ports
  ['http://127.0.0.1:3100', 'untracked'],
  ['http://127.0.0.1:8545', 'untracked'],
  ['http://192.168.1.10', 'untracked'],
  ['http://10.0.0.1', 'untracked'],
  ['http://172.16.0.5:8080', 'untracked'],
  ['http://[::1]:3000', 'untracked'],
  // public IPs
  ['http://8.8.8.8', 'untracked'],
  ['https://1.2.3.4', 'untracked'],
  ['HTTP://8.8.8.8', 'untracked'],
  // any origin with a port
  ['https://myapp.com:8545', 'untracked'],
  // extensions and files
  ['chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn', 'untracked'],
  ['CHROME-EXTENSION://NKBIHFBEOGAEAOEHLEFNKODBEFGPGKNN', 'untracked'],
  ['moz-extension://abc', 'untracked'],
  ['file:///Users/x/index.html', 'untracked'],
  ['file://', 'untracked'],
  // local TLDs
  ['http://x.local', 'untracked'],
  ['http://y.internal', 'untracked'],
  ['http://z.lan', 'untracked'],
  ['http://w.home', 'untracked'],
  ['http://app.localhost', 'untracked'],
  ['HTTP://X.LOCAL', 'untracked'],
  // not a domain
  ['*', 'untracked'],
  ['null', 'untracked'],
  ['unknown', 'untracked'],
  ['https://foo', 'untracked'],
  ['foo', 'untracked'],
  ['http://foo_bar.com', 'untracked'],
  ['https://foo.c', 'untracked'],
  ['https://' + 'a'.repeat(64) + '.com', 'untracked'],
  ['   ', 'untracked'],
  // no origin
  [undefined, 'none'],
  [null, 'none'],
  ['', 'none'],
];

test('classifyOrigin: every case gets its class', () => {
  for (const [origin, expected] of CASES) {
    assert.equal(classifyOrigin(origin), expected, `origin ${JSON.stringify(origin)}`);
  }
});

// The bucket checkRateLimit picked before it called classifyOrigin, verbatim.
function bucketBeforeRefactor(origin) {
  if (isExemptOrigin(origin)) return 'exempt';
  const cleanOrigin = normalizeOrigin(origin);
  const hasRealOrigin = cleanOrigin && !isLocalOrigin(cleanOrigin);
  return hasRealOrigin ? 'origin' : 'ip';
}
const bucketOf = { exempt: 'exempt', tracked: 'origin', untracked: 'ip', none: 'ip' };

test('classifyOrigin picks the same rate-limit bucket checkRateLimit used before (D2)', () => {
  for (const [origin] of CASES) {
    assert.equal(bucketOf[classifyOrigin(origin)], bucketBeforeRefactor(origin), `origin ${JSON.stringify(origin)}`);
  }
});

test('checkRateLimit: never limited with nothing blocked, for every case', () => {
  for (const [origin] of CASES) {
    assert.deepEqual(checkRateLimit('203.0.113.7', origin), { limited: false, reason: null, retryAfter: null });
  }
});

test('upstreamHeaders: untracked origins are dropped', () => {
  for (const [origin, cls] of CASES) {
    if (cls !== 'untracked' || origin.trim() === '') continue;
    const h = upstreamHeaders({ origin, 'user-agent': 'ua/1' }, '203.0.113.7');
    assert.equal('origin' in h, false, `origin ${JSON.stringify(origin)}`);
    assert.equal(h['user-agent'], 'ua/1');
    assert.equal(h['X-Client-IP'], '203.0.113.7');
  }
  // whitespace-only: also untracked, also dropped
  assert.equal('origin' in upstreamHeaders({ origin: '   ' }, '203.0.113.7'), false);
});

test('upstreamHeaders: tracked and exempt origins are forwarded exactly as sent', () => {
  for (const [origin, cls] of CASES) {
    if (cls !== 'tracked' && cls !== 'exempt') continue;
    const h = upstreamHeaders({ origin }, '203.0.113.7');
    assert.equal(h.origin, origin, `origin ${JSON.stringify(origin)}`);
  }
});

test('upstreamHeaders: no origin stays absent', () => {
  assert.equal('origin' in upstreamHeaders({ 'user-agent': 'ua/1' }, '203.0.113.7'), false);
  assert.equal('origin' in upstreamHeaders({ origin: '' }, '203.0.113.7'), false);
  assert.equal('origin' in upstreamHeaders(undefined), false);
});

test('upstreamHeaders: user-agent, X-Client-IP and the allowlist unchanged', () => {
  const caller = {
    origin: 'https://speedrunethereum.com', 'user-agent': 'ua/1',
    'x-client-ip': '6.6.6.6', 'x-api-key': 'secret', 'content-length': '99', referer: 'https://r.com/'
  };
  assert.deepEqual(upstreamHeaders(caller, '203.0.113.7'), {
    'Content-Type': 'application/json',
    'user-agent': 'ua/1',
    origin: 'https://speedrunethereum.com',
    'X-Client-IP': '203.0.113.7'
  });
  // fallback provider call: no client IP
  assert.deepEqual(upstreamHeaders({ ...caller, origin: 'http://localhost:3000' }), {
    'Content-Type': 'application/json',
    'user-agent': 'ua/1'
  });
});

test('upstreamHeaders: the caller\'s headers object is not modified', () => {
  const caller = { origin: 'http://localhost:3000', 'user-agent': 'ua/1' };
  upstreamHeaders(caller, '203.0.113.7');
  assert.deepEqual(caller, { origin: 'http://localhost:3000', 'user-agent': 'ua/1' });
});
