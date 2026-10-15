// node --test test/   (no network; a fake clock)
// bg-rpc-docs EDGE_BURST_LIMIT_PLAN.md, B1–B3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBurstLimiter, burstKey } from '../utils/burstLimiter.js';
import { burstLimits, burstLimitMode } from '../config.js';

const LIMITS = {
  origin: { bucketSize: 300, refillPerSecond: 30, maxInFlight: 50, maxGetLogsInFlight: 4 },
  ip: { bucketSize: 200, refillPerSecond: 20, maxInFlight: 20, maxGetLogsInFlight: 4 }
};
const APP = 'https://app.example.com';

function setup(mode = 'enforce', limits = LIMITS) {
  const clock = { t: 1_000_000 };
  const lines = [];
  const limiter = createBurstLimiter({ mode, limits, now: () => clock.t, log: l => lines.push(l) });
  return { limiter, clock, lines };
}
// One single-item request; released at once unless keep is set
function one(limiter, { ip = '1.2.3.4', origin = APP, units = 1, keep = false } = {}) {
  const r = limiter.admit({ ip, origin, units, items: 1 });
  if (!keep) r.release();
  return r;
}

test('config: log-only, the plan\'s starting numbers', () => {
  assert.equal(burstLimitMode, 'log');
  assert.deepEqual(burstLimits, LIMITS);
});

test('burstKey: same classes as the hourly limiter', () => {
  assert.equal(burstKey('1.2.3.4', 'https://App.Example.com/').key, 'origin:app.example.com');
  assert.equal(burstKey('1.2.3.4', undefined).key, 'ip:1.2.3.4');
  assert.equal(burstKey('1.2.3.4', 'http://localhost:3000').key, 'ip:1.2.3.4'); // untracked → per IP
  assert.equal(burstKey('1.2.3.4', 'buidlguidl-client'), null);                // exempt (D2)
});

test('B1: the bucket admits its size at once, then refills at its rate', () => {
  const { limiter, clock } = setup();
  for (let i = 0; i < 300; i++) assert.equal(one(limiter).refused, null);
  const r = one(limiter);
  assert.equal(r.refused.retryAfter, 1);
  assert.equal(r.refused.message, 'Too many requests in a short time for origin app.example.com; retry in 1 s');
  clock.t += 1000; // +30 units
  for (let i = 0; i < 30; i++) assert.equal(one(limiter).refused, null);
  assert.ok(one(limiter).refused);
});

test('B1: 3,000 requests in 3 s from one origin → bucket + 3 s of refill admitted', () => {
  const { limiter, clock } = setup();
  let admitted = 0;
  for (let i = 0; i < 3000; i++) {
    clock.t += 1; // 3,000 over 3 s
    if (!one(limiter).refused) admitted++;
  }
  assert.ok(admitted >= 385 && admitted <= 391, `admitted ${admitted}`);
  // another origin is unaffected
  assert.equal(one(limiter, { origin: 'https://other.example.org' }).refused, null);
});

test('B1: a batch is admitted or refused whole', () => {
  const { limiter } = setup();
  assert.equal(limiter.admit({ ip: '1.2.3.4', origin: APP, units: 260, items: 1 }).refused, null); // 40 left
  const r = limiter.admit({ ip: '1.2.3.4', origin: APP, units: 50, items: 1 });
  assert.equal(r.refused.retryAfter, 1); // (50 - 40) / 30 → 1 s
  assert.equal(one(limiter, { units: 40 }).refused, null); // nothing was taken by the refusal
});

test('B1: a request bigger than the bucket goes through when the bucket is full, and empties it', () => {
  const { limiter, clock } = setup();
  assert.equal(limiter.admit({ ip: '1.2.3.4', origin: APP, units: 1000, items: 1 }).refused, null);
  assert.ok(one(limiter).refused);
  const r = limiter.admit({ ip: '1.2.3.4', origin: APP, units: 1000, items: 1 });
  assert.equal(r.refused.retryAfter, 10); // a full bucket again: 300 / 30
  clock.t += 10_000;
  assert.equal(limiter.admit({ ip: '1.2.3.4', origin: APP, units: 1000, items: 1 }).refused, null);
});

test('B1: IPs with no origin have their own, smaller bucket', () => {
  const { limiter } = setup();
  for (let i = 0; i < 200; i++) assert.equal(one(limiter, { origin: null }).refused, null);
  const r = one(limiter, { origin: null });
  assert.equal(r.refused.message, 'Too many requests in a short time for this IP; retry in 1 s');
  assert.equal(one(limiter, { origin: null, ip: '5.6.7.8' }).refused, null);
});

test('B2: items in flight are capped and given back on release (once)', () => {
  const { limiter } = setup();
  const held = [];
  for (let i = 0; i < 20; i++) held.push(one(limiter, { origin: null, keep: true }));
  const r = one(limiter, { origin: null });
  assert.equal(r.refused.retryAfter, 1);
  held[0].release();
  held[0].release(); // a second close doesn't free a second slot
  assert.equal(one(limiter, { origin: null, keep: true }).refused, null);
  assert.ok(one(limiter, { origin: null }).refused);
});

test('B2: a batch bigger than the cap goes through when nothing is in flight', () => {
  const { limiter } = setup();
  const batch = limiter.admit({ ip: '1.2.3.4', units: 50, items: 50 }); // IP cap 20
  assert.equal(batch.refused, null);
  assert.ok(one(limiter, { origin: null }).refused);
  batch.release();
  assert.equal(one(limiter, { origin: null }).refused, null);
});

test('B3: at most 4 getLogs in flight per caller; another caller still gets in', () => {
  const { limiter } = setup();
  const held = [];
  for (let i = 0; i < 4; i++) held.push(limiter.admit({ ip: '1.2.3.4', origin: APP, units: 2, items: 1, getLogsItems: 1 }));
  assert.ok(held.every(h => h.refused === null));
  assert.ok(limiter.admit({ ip: '1.2.3.4', origin: APP, units: 2, items: 1, getLogsItems: 1 }).refused);
  assert.equal(one(limiter).refused, null); // other methods are not held back
  assert.equal(limiter.admit({ ip: '9.9.9.9', origin: 'https://other.example.org', units: 2, items: 1, getLogsItems: 1 }).refused, null);
  held[0].release();
  assert.equal(limiter.admit({ ip: '1.2.3.4', origin: APP, units: 2, items: 1, getLogsItems: 1 }).refused, null);
});

test('exempt origins are never limited (D2)', () => {
  const { limiter } = setup();
  for (let i = 0; i < 1000; i++) assert.equal(one(limiter, { origin: 'buidlguidl-client', keep: true }).refused, null);
  assert.equal(limiter.status().callersTracked, 0);
});

test('log mode: nothing refused; what enforcement would refuse is logged and counted, and takes nothing', () => {
  const { limiter, clock, lines } = setup('log');
  for (let i = 0; i < 300; i++) one(limiter);
  for (let i = 0; i < 5; i++) assert.equal(one(limiter).refused, null);
  assert.equal(lines.filter(l => l.includes('Would refuse (log-only) origin:app.example.com: bucket')).length, 1); // one line per 10 s
  clock.t += 10_000; // refills the bucket fully; would-refusals took no tokens
  for (let i = 0; i < 300; i++) one(limiter);
  one(limiter);
  assert.match(lines.at(-1), /\(\+4 more since the last line\)$/);
  const s = limiter.status();
  assert.equal(s.mode, 'log');
  assert.equal(s.totals.refused, 6);
  assert.equal(s.totals.bucket, 6);
  assert.equal(s.totals.admitted, 600);
  assert.deepEqual(s.topRefused[0], { key: 'origin:app.example.com', refused: 6, byCheck: { bucket: 6, inFlight: 0, getLogs: 0 } });
});

test('off mode: nothing checked or tracked', () => {
  const { limiter } = setup('off');
  for (let i = 0; i < 1000; i++) assert.equal(one(limiter, { keep: true }).refused, null);
  assert.equal(limiter.status().callersTracked, 0);
});

test('sweep: forgets callers with a full bucket and nothing in flight', () => {
  const { limiter, clock } = setup();
  one(limiter, { ip: 'a' , origin: null });
  const held = one(limiter, { ip: 'b', origin: null, keep: true });
  clock.t += 60_000;
  limiter.sweep();
  assert.equal(limiter.status().callersTracked, 1); // 'b' is still in flight
  held.release();
  limiter.sweep();
  assert.equal(limiter.status().callersTracked, 0);
});
