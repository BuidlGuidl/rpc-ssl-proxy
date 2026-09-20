/**
 * Bound the block range of an eth_getLogs call.
 *
 * Unbounded ranges are what actually hurt nodes, so keyed callers get
 * eth_getLogs only within `getLogsMaxBlockRange` blocks per call.
 *
 * Tags: "earliest" is block 0; "latest"/"pending"/"safe"/"finalized" resolve
 * to the proxy's cached head. If no head is known and the range needs one,
 * the call is refused with a message asking for explicit block numbers.
 */

import { getLogsMaxBlockRange } from '../config.js';

const HEAD_TAGS = new Set(['latest', 'pending', 'safe', 'finalized']);

/**
 * @returns {{ ok: true, range: number } | { ok: false, message: string }}
 */
function checkGetLogsParams(params, latestBlock = null, maxRange = getLogsMaxBlockRange) {
  const filter = Array.isArray(params) ? params[0] : undefined;
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    return { ok: false, message: 'eth_getLogs: params[0] must be a filter object' };
  }
  if (filter.blockHash !== undefined && filter.blockHash !== null) {
    return { ok: true, range: 1 };
  }

  const from = resolveBlock(filter.fromBlock, latestBlock, 'fromBlock');
  if (from.error) return { ok: false, message: from.error };
  const to = resolveBlock(filter.toBlock, latestBlock, 'toBlock');
  if (to.error) return { ok: false, message: to.error };

  if (from.value > to.value) {
    return { ok: false, message: 'eth_getLogs: fromBlock is after toBlock' };
  }
  const range = to.value - from.value + 1;
  if (range > maxRange) {
    return { ok: false, message: `eth_getLogs: block range ${range} exceeds the maximum of ${maxRange} blocks per call` };
  }
  return { ok: true, range };
}

function resolveBlock(raw, latestBlock, name) {
  if (raw === undefined || raw === null) raw = 'latest';
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) return { error: `eth_getLogs: ${name} must be a non-negative block number` };
    return { value: raw };
  }
  if (typeof raw !== 'string') return { error: `eth_getLogs: ${name} must be a hex block number or tag` };
  const s = raw.trim().toLowerCase();
  if (s === 'earliest') return { value: 0 };
  if (HEAD_TAGS.has(s)) {
    if (latestBlock === null || latestBlock === undefined) {
      return { error: `eth_getLogs: ${name} "${s}" cannot be resolved right now, pass an explicit hex block number` };
    }
    return { value: latestBlock };
  }
  if (/^0x[0-9a-f]+$/.test(s)) {
    const n = parseInt(s, 16);
    if (!Number.isSafeInteger(n)) return { error: `eth_getLogs: ${name} is out of range` };
    return { value: n };
  }
  if (/^\d+$/.test(s)) return { value: parseInt(s, 10) };
  return { error: `eth_getLogs: ${name} must be a hex block number or tag` };
}

export { checkGetLogsParams };
