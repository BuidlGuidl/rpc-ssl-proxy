/**
 * Per-API-key limits, kept in proxy memory.
 *
 * Two controls:
 *   1. A rolling-hour budget of weighted request units, charged BEFORE the
 *      request is forwarded. A call that times out downstream still costs.
 *      (The IP/origin limiter only counts successful responses, which is
 *      why heavy calls that time out were never limited.)
 *   2. A cap on concurrent eth_getLogs per key. Parallel heavy calls are
 *      what hurt nodes, not the hourly total.
 *
 * The rolling hour uses the same approximation as rateLimiter.js:
 *   effective = current_hour + previous_hour * (fraction of hour remaining)
 */

import { apiKeyRateLimitPerHour, getLogsMaxInFlightPerKey } from '../config.js';

const state = {
  hourStart: null,          // ms timestamp of the current hour bucket
  current: new Map(),       // key -> units this hour
  previous: new Map(),      // key -> units previous hour
  inFlightGetLogs: new Map(), // key -> count
};

function hourFloor(now) {
  return now - (now % 3600000);
}

/** Roll buckets if the wall clock moved into a new hour. */
function roll(now) {
  const h = hourFloor(now);
  if (state.hourStart === null) {
    state.hourStart = h;
    return;
  }
  if (h === state.hourStart) return;
  if (h - state.hourStart >= 7200000) {
    // Two or more hours idle: nothing carries over.
    state.previous = new Map();
  } else {
    state.previous = state.current;
  }
  state.current = new Map();
  state.hourStart = h;
}

function effectiveUnits(key, now) {
  const fractionRemaining = 1 - ((now - state.hourStart) / 3600000);
  const cur = state.current.get(key) || 0;
  const prev = state.previous.get(key) || 0;
  return cur + prev * fractionRemaining;
}

/**
 * Charge `units` to `key` if the budget allows.
 * Returns { limited: false, effective } or { limited: true, effective, retryAfter }.
 */
function consumeKeyUnits(key, units, now = Date.now(), limit = apiKeyRateLimitPerHour) {
  roll(now);
  const before = effectiveUnits(key, now);
  if (before + units > limit) {
    const retryAfter = Math.max(1, Math.ceil((state.hourStart + 3600000 - now) / 1000));
    return { limited: true, effective: Math.round(before), limit, retryAfter };
  }
  state.current.set(key, (state.current.get(key) || 0) + units);
  return { limited: false, effective: Math.round(before + units), limit };
}

/** Reserve `n` eth_getLogs slots for `key`. Returns false (and reserves nothing) if over the cap. */
function acquireGetLogsSlots(key, n = 1, max = getLogsMaxInFlightPerKey) {
  if (n <= 0) return true;
  const cur = state.inFlightGetLogs.get(key) || 0;
  if (cur + n > max) return false;
  state.inFlightGetLogs.set(key, cur + n);
  return true;
}

function releaseGetLogsSlots(key, n = 1) {
  if (n <= 0) return;
  const cur = state.inFlightGetLogs.get(key) || 0;
  const next = cur - n;
  if (next <= 0) state.inFlightGetLogs.delete(key);
  else state.inFlightGetLogs.set(key, next);
}

function getInFlightGetLogs(key) {
  return state.inFlightGetLogs.get(key) || 0;
}

/** Test hook. */
function resetKeyRateLimiter() {
  state.hourStart = null;
  state.current = new Map();
  state.previous = new Map();
  state.inFlightGetLogs = new Map();
}

/** For /status. Keys are masked. */
function getKeyRateLimitStatus(now = Date.now()) {
  roll(now);
  const mask = k => `${k.slice(0, 4)}…${k.slice(-2)}`;
  const keys = new Set([...state.current.keys(), ...state.previous.keys()]);
  const active = [];
  for (const key of keys) {
    active.push({ key: mask(key), effective: Math.round(effectiveUnits(key, now)), inFlightGetLogs: getInFlightGetLogs(key) });
  }
  active.sort((a, b) => b.effective - a.effective);
  return { limitPerHour: apiKeyRateLimitPerHour, maxInFlightGetLogs: getLogsMaxInFlightPerKey, activeKeys: active.length, top: active.slice(0, 20) };
}

export {
  consumeKeyUnits,
  acquireGetLogsSlots,
  releaseGetLogsSlots,
  getInFlightGetLogs,
  resetKeyRateLimiter,
  getKeyRateLimitStatus,
};
