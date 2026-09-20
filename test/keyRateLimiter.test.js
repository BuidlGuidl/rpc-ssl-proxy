import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeKeyUnits, acquireGetLogsSlots, releaseGetLogsSlots, getInFlightGetLogs, resetKeyRateLimiter } from '../utils/keyRateLimiter.js';

const H = 3600000;
const T0 = 1700000000000 - (1700000000000 % H); // top of an hour

test('units are charged up front and refused past the limit', () => {
  resetKeyRateLimiter();
  assert.equal(consumeKeyUnits('k1', 60, T0, 100).limited, false);
  assert.equal(consumeKeyUnits('k1', 40, T0, 100).limited, false);
  const r = consumeKeyUnits('k1', 1, T0, 100);
  assert.equal(r.limited, true);
  assert.equal(r.retryAfter, 3600);
});

test('keys are independent', () => {
  resetKeyRateLimiter();
  consumeKeyUnits('a', 100, T0, 100);
  assert.equal(consumeKeyUnits('b', 100, T0, 100).limited, false);
});

test('previous hour decays across the rolling window', () => {
  resetKeyRateLimiter();
  consumeKeyUnits('k', 100, T0, 100);
  // Top of next hour: previous counts fully, still blocked
  assert.equal(consumeKeyUnits('k', 1, T0 + H, 100).limited, true);
  // Half way through: previous counts 50%, so 50 more fit
  assert.equal(consumeKeyUnits('k', 50, T0 + H + H / 2, 100).limited, false);
  assert.equal(consumeKeyUnits('k', 1, T0 + H + H / 2, 100).limited, true);
  // Two hours idle: nothing carries
  assert.equal(consumeKeyUnits('k', 100, T0 + 4 * H, 100).limited, false);
});

test('getLogs slots cap concurrency per key and release', () => {
  resetKeyRateLimiter();
  assert.equal(acquireGetLogsSlots('k', 1, 2), true);
  assert.equal(acquireGetLogsSlots('k', 1, 2), true);
  assert.equal(acquireGetLogsSlots('k', 1, 2), false);
  assert.equal(getInFlightGetLogs('k'), 2);
  releaseGetLogsSlots('k', 1);
  assert.equal(acquireGetLogsSlots('k', 1, 2), true);
  releaseGetLogsSlots('k', 5); // over-release never goes negative
  assert.equal(getInFlightGetLogs('k'), 0);
  assert.equal(acquireGetLogsSlots('k', 3, 2), false); // batch bigger than cap
});
