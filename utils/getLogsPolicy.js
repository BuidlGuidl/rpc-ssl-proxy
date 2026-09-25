/**
 * getLogs policy (bg-rpc-docs plan, Phase 4d) and the chain state it needs.
 *
 * validateGetLogs(item) checks one JSON-RPC item against the range cap, the pool's
 * receipt floor, tag rules and filter-shape sanity limits, without touching the
 * network. The head and floor come from two pollers started by startGetLogsPollers():
 *   - head: eth_blockNumber to TARGET_URL every getLogsHeadPollInterval seconds
 *     (bg-rpc-proxy answers from its cache; no node sees it)
 *   - floor: GET <TARGET_URL origin>/getlogsStatus every getLogsFloorPollInterval
 *     seconds (the pool's max receipt_floor over ready reth nodes)
 * Fail closed: until both are known and fresh, getLogs returns -32603 "getLogs not
 * ready". RECEIPT_FLOOR_OVERRIDE (env) pins the floor and is the only manual path.
 */

import axios from 'axios';
import https from 'https';
import {
  getLogsMaxBlockRange,
  getLogsMaxAddresses,
  getLogsMaxTopics,
  getLogsHeadPollInterval,
  getLogsFloorPollInterval,
  getLogsHeadMaxAge,
  getLogsFloorMaxAge
} from '../config.js';

// ---------------------------------------------------------------------------
// Chain state
// ---------------------------------------------------------------------------

const state = {
  head: null,          // number
  headAt: 0,           // ms epoch of the last successful head poll
  receiptFloor: null,  // number
  floorAt: 0,
  readyNodes: null,
  poolInFlight: null,
  floorOverride: null, // number, from RECEIPT_FLOOR_OVERRIDE
  lastHeadError: null,
  lastFloorError: null
};

const pollAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function parseQuantity(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const n = Number.parseInt(value, 16);
  return Number.isSafeInteger(n) ? n : null;
}

async function pollHead(targetUrl) {
  try {
    const { data } = await axios.post(targetUrl, { jsonrpc: '2.0', id: 'edge-head', method: 'eth_blockNumber', params: [] }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
      httpsAgent: pollAgent
    });
    const head = parseQuantity(data?.result);
    if (head === null) throw new Error(`unexpected eth_blockNumber result: ${JSON.stringify(data).slice(0, 200)}`);
    state.head = head;
    state.headAt = Date.now();
    state.lastHeadError = null;
  } catch (err) {
    state.lastHeadError = err.message;
    console.log(`⚠️  getLogs head poll failed: ${err.message}`);
  }
}

async function pollFloor(statusUrl) {
  try {
    const { data } = await axios.get(statusUrl, { timeout: 5000, httpsAgent: pollAgent });
    const floor = Number.isInteger(data?.receiptFloor) ? data.receiptFloor : null;
    state.readyNodes = Number.isInteger(data?.readyNodes) ? data.readyNodes : null;
    state.poolInFlight = Number.isInteger(data?.inFlight) ? data.inFlight : null;
    if (floor === null || !(state.readyNodes > 0)) {
      throw new Error(`no ready getLogs nodes (${JSON.stringify(data).slice(0, 200)})`);
    }
    state.receiptFloor = floor;
    state.floorAt = Date.now();
    state.lastFloorError = null;
  } catch (err) {
    state.lastFloorError = err.message;
    console.log(`⚠️  getLogs floor poll failed: ${err.message}`);
  }
}

/**
 * Start the head and floor pollers. Safe to call once at startup.
 * @param {string} targetUrl - TARGET_URL (bg-rpc-proxy's public port)
 */
function startGetLogsPollers(targetUrl) {
  const override = process.env.RECEIPT_FLOOR_OVERRIDE;
  if (override !== undefined && override !== '') {
    const n = Number(override);
    if (!Number.isInteger(n) || n < 0) {
      console.error(`RECEIPT_FLOOR_OVERRIDE must be a non-negative integer, got "${override}"`);
      process.exit(1);
    }
    state.floorOverride = n;
    console.log(`⚠️  getLogs receipt floor pinned by RECEIPT_FLOOR_OVERRIDE = ${n}`);
  }

  let statusUrl;
  try {
    statusUrl = new URL('/getlogsStatus', targetUrl).toString();
  } catch {
    console.error(`TARGET_URL is not a valid URL: ${targetUrl}`);
    process.exit(1);
  }

  pollHead(targetUrl);
  setInterval(() => pollHead(targetUrl), getLogsHeadPollInterval * 1000).unref();
  if (state.floorOverride === null) {
    pollFloor(statusUrl);
    setInterval(() => pollFloor(statusUrl), getLogsFloorPollInterval * 1000).unref();
  }
  console.log(`🪵 getLogs pollers started: head every ${getLogsHeadPollInterval} s from ${targetUrl}, floor every ${getLogsFloorPollInterval} s from ${statusUrl}`);
}

function currentHead() {
  if (state.head === null) return null;
  if (Date.now() - state.headAt > getLogsHeadMaxAge * 1000) return null;
  return state.head;
}

function currentFloor() {
  if (state.floorOverride !== null) return state.floorOverride;
  if (state.receiptFloor === null) return null;
  if (Date.now() - state.floorAt > getLogsFloorMaxAge * 1000) return null;
  return state.receiptFloor;
}

/** Non-sensitive snapshot for /status. */
function getGetLogsState() {
  const now = Date.now();
  return {
    head: state.head,
    headAgeSeconds: state.headAt ? Math.round((now - state.headAt) / 1000) : null,
    receiptFloor: currentFloor(),
    floorSource: state.floorOverride !== null ? 'override' : 'pool',
    floorAgeSeconds: state.floorAt ? Math.round((now - state.floorAt) / 1000) : null,
    poolReadyNodes: state.readyNodes,
    poolInFlight: state.poolInFlight,
    ready: currentHead() !== null && currentFloor() !== null,
    lastHeadError: state.lastHeadError,
    lastFloorError: state.lastFloorError
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const invalid = (message) => ({ ok: false, error: { code: -32602, message }, blockCount: 0 });

/**
 * Resolve a block tag or quantity against the head.
 * @returns {{ value?: number, error?: string }}
 */
function resolveBlock(raw, field, head) {
  if (raw === undefined || raw === null) return { value: head }; // missing → latest
  if (typeof raw === 'string') {
    switch (raw) {
      case 'latest':
      case 'safe':
      case 'finalized':
        return { value: head };
      case 'earliest':
        return { value: 0 };
      case 'pending':
        return { error: `"pending" is not supported for eth_getLogs` };
      default:
        break;
    }
  }
  const n = parseQuantity(raw);
  if (n === null) return { error: `Invalid params: ${field} must be a hex block number or one of latest, safe, finalized, earliest` };
  return { value: n };
}

/**
 * The filter object of an eth_getLogs / eth_newFilter item. Reth accepts both the
 * positional form (params: [filter]) and the by-name form (params: {filter: {...}});
 * the pool reads both (1c follow-up), so the edge must too or by-name requests would
 * skip the range cap, floor check and tag rules.
 */
function extractFilter(params) {
  if (Array.isArray(params)) return params[0];
  if (params && typeof params === 'object') return params.filter;
  return undefined;
}

/**
 * Validate one JSON-RPC item on the getLogs path.
 * @param {object} item - { method, params, id }
 * @returns {{ ok: boolean, error?: { code: number, message: string }, blockCount: number }}
 */
function validateGetLogs(item) {
  const method = item?.method;

  // The node owns the filter; nothing to check here (the pool caps these by count).
  if (method === 'eth_getFilterLogs' || method === 'eth_getFilterChanges') {
    return { ok: true, blockCount: 0 };
  }

  const head = currentHead();
  const floor = currentFloor();
  if (head === null || floor === null) {
    return { ok: false, error: { code: -32603, message: 'getLogs not ready' }, blockCount: 0 };
  }

  const filter = extractFilter(item?.params);
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    return invalid('Invalid params: expected a filter object, positional (params[0]) or by name (params.filter)');
  }

  // Shape sanity
  if (filter.address !== undefined && filter.address !== null) {
    const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
    if (addresses.length > getLogsMaxAddresses) {
      return invalid(`Invalid params: at most ${getLogsMaxAddresses} addresses per call`);
    }
  }
  if (filter.topics !== undefined && filter.topics !== null) {
    if (!Array.isArray(filter.topics)) return invalid('Invalid params: topics must be an array');
    if (filter.topics.length > getLogsMaxTopics) {
      return invalid(`Invalid params: at most ${getLogsMaxTopics} topic positions`);
    }
  }

  // blockHash filter (D11): one block, no range checks; reth answers -32001 if unknown.
  if (filter.blockHash !== undefined && filter.blockHash !== null) {
    if (typeof filter.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(filter.blockHash)) {
      return invalid('Invalid params: blockHash must be a 32-byte hex string');
    }
    return { ok: true, blockCount: 1 };
  }

  const from = resolveBlock(filter.fromBlock, 'fromBlock', head);
  if (from.error) return invalid(from.error);
  const to = resolveBlock(filter.toBlock, 'toBlock', head);
  if (to.error) return invalid(to.error);

  if (from.value > to.value) {
    return invalid(`Invalid params: fromBlock (${from.value}) is greater than toBlock (${to.value})`);
  }

  const blockCount = to.value - from.value + 1;
  if (blockCount > getLogsMaxBlockRange) {
    const suggestedTo = from.value + getLogsMaxBlockRange - 1;
    return invalid(
      `Log request range too large. You can request up to ${getLogsMaxBlockRange} blocks per call. ` +
      `Try [0x${from.value.toString(16)}, 0x${suggestedTo.toString(16)}].`
    );
  }

  if (from.value < floor) {
    return invalid(`Logs older than block ${floor} are not available on this endpoint (history is ~100 days).`);
  }

  return { ok: true, blockCount };
}

export { validateGetLogs, startGetLogsPollers, getGetLogsState };
