/**
 * Short-window limits per caller (bg-rpc-docs EDGE_BURST_LIMIT_PLAN.md, B1–B3).
 *
 * The hourly and daily limits (utils/rateLimiter.js) react 10–20 s late and count only
 * finished requests, so a burst of thousands of requests in a few seconds reaches the
 * pool in full. This limiter decides at admission, in memory (the edge is one process,
 * D1), with three checks per caller:
 *
 *   B1 a token bucket in request units (utils/requestUnits.js): bucketSize at most at
 *      once, refilled at refillPerSecond. A request costs the sum of its items' units;
 *      a batch is admitted or refused whole.
 *   B2 items in flight at most maxInFlight.
 *   B3 getLogs-path items in flight at most maxGetLogsInFlight (a share of the edge's
 *      getLogs slots).
 *
 * Caller key: the hourly limiter's (classifyOrigin): a tracked origin → per origin; no
 * origin or an untracked one → per IP; exempt origins → no limit (D2).
 *
 * A request bigger than a limit could never be admitted, so it is admitted when that
 * limit is untouched: a full bucket (it then takes the whole bucket), nothing in flight.
 *
 * Modes (config.js burstLimitMode):
 *   'off'     nothing checked
 *   'log'     every request goes through; the ones enforcement would refuse are logged
 *             and counted (D4). They take no tokens and no in-flight slots, as under
 *             enforcement, so the log shows what enforcement would do.
 *   'enforce' refused requests get HTTP 429 (proxy.js)
 */

import { classifyOrigin } from './rateLimiter.js';
import { normalizeOrigin } from './originValidator.js';

const LOG_EVERY_MS = 10_000;     // at most one log line per caller per 10 s; the rest are counted
const SWEEP_EVERY_MS = 60_000;   // forget callers whose bucket is full and nothing is in flight
const MAX_TRACKED_REFUSERS = 1000;

/** The limiter key for a caller, or null for an exempt origin. */
function burstKey(ip, origin) {
  const originClass = classifyOrigin(origin);
  if (originClass === 'exempt') return null;
  if (originClass === 'tracked') return { key: `origin:${normalizeOrigin(origin)}`, scope: 'origin', label: `origin ${normalizeOrigin(origin)}` };
  return { key: `ip:${ip}`, scope: 'ip', label: 'this IP' };
}

/**
 * @param {object} opts
 * @param {'off'|'log'|'enforce'} opts.mode
 * @param {{ origin: object, ip: object }} opts.limits - per scope: { bucketSize, refillPerSecond, maxInFlight, maxGetLogsInFlight }
 * @param {() => number} [opts.now] - clock in ms (tests)
 * @param {(line: string) => void} [opts.log]
 */
function createBurstLimiter({ mode, limits, now = Date.now, log = console.log }) {
  const callers = new Map(); // key → { tokens, at, inFlight, getLogsInFlight, lastLogAt, unlogged }
  const refusers = new Map(); // key → { count, byCheck: { bucket, inFlight, getLogs } }
  const totals = { admitted: 0, refused: 0, bucket: 0, inFlight: 0, getLogs: 0 };
  const startedAt = now();

  function stateOf(key, limit) {
    let s = callers.get(key);
    if (!s) {
      s = { tokens: limit.bucketSize, at: now(), inFlight: 0, getLogsInFlight: 0, lastLogAt: 0, unlogged: 0 };
      callers.set(key, s);
    }
    return s;
  }

  function refill(s, limit) {
    const t = now();
    s.tokens = Math.min(limit.bucketSize, s.tokens + ((t - s.at) / 1000) * limit.refillPerSecond);
    s.at = t;
  }

  // Which check refuses, or null
  function refusal(s, limit, units, items, getLogsItems) {
    if (s.inFlight > 0 && s.inFlight + items > limit.maxInFlight) {
      return { check: 'inFlight', retryAfter: 1, detail: `${s.inFlight} in flight + ${items} > ${limit.maxInFlight}` };
    }
    if (getLogsItems > 0 && s.getLogsInFlight > 0 && s.getLogsInFlight + getLogsItems > limit.maxGetLogsInFlight) {
      return { check: 'getLogs', retryAfter: 1, detail: `${s.getLogsInFlight} getLogs in flight + ${getLogsItems} > ${limit.maxGetLogsInFlight}` };
    }
    const need = Math.min(units, limit.bucketSize);
    if (s.tokens < need) {
      return {
        check: 'bucket',
        retryAfter: Math.max(1, Math.ceil((need - s.tokens) / limit.refillPerSecond)),
        detail: `${units} unit(s), ${Math.floor(s.tokens)} left of ${limit.bucketSize}`
      };
    }
    return null;
  }

  function noteRefusal(caller, s, r, units, items) {
    totals.refused++;
    totals[r.check]++;
    let entry = refusers.get(caller.key);
    if (!entry && refusers.size < MAX_TRACKED_REFUSERS) {
      entry = { count: 0, byCheck: { bucket: 0, inFlight: 0, getLogs: 0 } };
      refusers.set(caller.key, entry);
    }
    if (entry) { entry.count++; entry.byCheck[r.check]++; }

    const t = now();
    if (t - s.lastLogAt < LOG_EVERY_MS) { s.unlogged++; return; }
    const more = s.unlogged > 0 ? ` (+${s.unlogged} more since the last line)` : '';
    s.lastLogAt = t;
    s.unlogged = 0;
    const verb = mode === 'enforce' ? 'Refused' : 'Would refuse (log-only)';
    log(`🪣 Burst: ${verb} ${caller.key}: ${r.check} (${r.detail}); ${items} item(s), ${units} unit(s); retry in ${r.retryAfter} s${more}`);
  }

  /**
   * Decide on one request.
   * @returns {{ refused: object|null, release: () => void }} refused (enforce mode only):
   *   { retryAfter, message } for the 429. release(): call when the response closes.
   */
  function admit({ ip, origin, units, items, getLogsItems = 0 }) {
    const none = { refused: null, release: () => {} };
    if (mode !== 'log' && mode !== 'enforce') return none;
    const caller = burstKey(ip, origin);
    if (!caller) return none;
    const limit = limits[caller.scope];
    const s = stateOf(caller.key, limit);
    refill(s, limit);

    const r = refusal(s, limit, units, items, getLogsItems);
    if (r) {
      noteRefusal(caller, s, r, units, items);
      if (mode !== 'enforce') return none;
      return {
        refused: { retryAfter: r.retryAfter, message: `Too many requests in a short time for ${caller.label}; retry in ${r.retryAfter} s` },
        release: () => {}
      };
    }

    totals.admitted++;
    s.tokens -= Math.min(units, limit.bucketSize);
    s.inFlight += items;
    s.getLogsInFlight += getLogsItems;
    let released = false;
    return {
      refused: null,
      release: () => {
        if (released) return;
        released = true;
        // A caller with items in flight is never swept, so s is still the live state
        s.inFlight = Math.max(0, s.inFlight - items);
        s.getLogsInFlight = Math.max(0, s.getLogsInFlight - getLogsItems);
      }
    };
  }

  function sweep() {
    for (const [key, s] of callers) {
      const limit = limits[key.startsWith('origin:') ? 'origin' : 'ip'];
      refill(s, limit);
      if (s.inFlight === 0 && s.getLogsInFlight === 0 && s.tokens >= limit.bucketSize) callers.delete(key);
    }
  }

  let timer = null;
  function start() {
    if (timer || (mode !== 'log' && mode !== 'enforce')) return;
    timer = setInterval(sweep, SWEEP_EVERY_MS);
    timer.unref?.();
    log(`🪣 Burst limiter: ${mode} (origin ${limits.origin.bucketSize} units +${limits.origin.refillPerSecond}/s, ${limits.origin.maxInFlight} in flight; IP ${limits.ip.bucketSize} units +${limits.ip.refillPerSecond}/s, ${limits.ip.maxInFlight} in flight)`);
  }

  /** For /ratelimitstatus: totals since start and the callers refused most. */
  function status() {
    const top = [...refusers.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([key, e]) => ({ key, refused: e.count, byCheck: e.byCheck }));
    return { mode, limits, since: new Date(startedAt).toISOString(), callersTracked: callers.size, totals: { ...totals }, topRefused: top };
  }

  return { admit, sweep, start, status };
}

export { createBurstLimiter, burstKey };
